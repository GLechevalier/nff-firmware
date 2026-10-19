// tcp.ts — minimal userspace TCP for one spliced flow (the WiredLink creates one TcpSplice per
// device flow: the MQTT-over-mTLS session to the synthetic broker address, and any DNS-resolved
// destination such as the OTA artifact download). We answer the device's SYN locally and splice
// the byte stream into the WebSocket bridge; the payload is opaque (TLS end-to-end to the peer).
//
// Deliberate simplifications, justified by the link (a mostly-lossless in-order USB pipe to a
// single lwIP peer):
//  - in-order receive only: out-of-order segments are dropped and re-ACKed, the device retransmits
//  - fixed MSS 1460, no SACK, no window scaling, no congestion control (flow control = the
//    device's advertised window and a small in-flight cap)
//  - loss recovery is go-back-N: 3 duplicate ACKs (or a 1 s RTO on the oldest unacked, clocked on
//    ACK progress — never on our own sends) retransmit a 4×MSS burst from the hole; 8 RTOs then
//    RST. Single-segment-per-RTO recovery starved bulk transfers (the ~1 MB OTA artifact) to
//    ~100 B/s, because the in-order receiver drops everything past a hole.
// Sequence arithmetic is mod 2^32 throughout (hence the >>> 0 and seqLt helper).

import { buildIpv4, IPPROTO_TCP, transportChecksum } from './ipv4';
import { linkScheduler } from './pump';

const MSS = 1460;
// In-flight cap: 8 KB (was 32 KB). Two concurrent flows share one 460 kbaud serial pipe (a bulk
// OTA download + the live MQTT session); a 32 KB burst monopolizes the pipe for ~700 ms, so the
// OTHER flow's segments (and its SYN-ACKs) queue long enough to look dead. 8 KB keeps per-flow
// pipe latency low so control traffic round-trips while bulk streams.
const MAX_INFLIGHT = 8 * 1024;
// RTO: exponential backoff from 1 s, and give up only after ~2 min of total silence (was 8×1 s).
// Mid-OTA the device stalls receive processing for seconds at a time (flash erase/write bursts);
// on this mostly-lossless USB pipe an unACKed segment means "busy peer", almost never "dead peer".
// RSTing after 8 s is what killed the MQTT flow ~60 s into every concurrent download.
const RETRANSMIT_MS = 1000;
const RETRANSMIT_MAX_MS = 16000;
const MAX_RETRIES = 12;   // 1+2+4+8+16+16+... ≈ 2 min before the flow is declared dead
// Go-back-N burst: how much of the unacked queue a retransmission resends. The device receives
// strictly in order, so everything past a lost segment was dropped — resending only the oldest
// (the old behavior) recovered one MSS per RTO and collapsed bulk transfers (the 1 MB OTA
// artifact) to ~100 B/s. 4×MSS per burst refills the device's default lwIP window in one round.
const GO_BACK_BYTES = 4 * MSS;
const DUP_ACK_FAST_RETRANSMIT = 3;

const FIN = 0x01, SYN = 0x02, RST = 0x04, PSH = 0x08, ACK = 0x10;

const add32 = (a: number, b: number) => (a + b) >>> 0;
const seqLt = (a: number, b: number) => ((b - a) >>> 0) < 0x80000000 && a !== b;
const seqLe = (a: number, b: number) => a === b || seqLt(a, b);

interface Segment {
  srcPort: number; dstPort: number;
  seq: number; ack: number;
  flags: number; window: number;
  payload: Uint8Array;
}

function parseTcp(data: Uint8Array): Segment | null {
  if (data.length < 20) return null;
  const off = (data[12] >>> 4) * 4;
  if (off < 20 || off > data.length) return null;
  return {
    srcPort: (data[0] << 8) | data[1],
    dstPort: (data[2] << 8) | data[3],
    seq: ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0,
    ack: ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0,
    flags: data[13],
    window: (data[14] << 8) | data[15],
    payload: data.slice(off),
  };
}

type State = 'closed' | 'syn-rcvd' | 'established' | 'last-ack';

export interface TcpSpliceEvents {
  /** Device completed the handshake — time to open the bridge. */
  onOpen: () => void;
  /** In-order payload bytes for the bridge. */
  onData: (data: Uint8Array) => void;
  /** Flow is gone (FIN/RST/retry exhaustion) — close the bridge. */
  onClose: () => void;
}

export class TcpSplice {
  state: State = 'closed';
  private devPort = 0;
  private rcvNxt = 0;
  private sndNxt = 0;
  private sndUna = 0;
  private peerWindow = 0;
  private retries = 0;
  private dupAcks = 0;
  // RTO clock: time since the oldest unacked segment last had a chance (ack progress or a
  // retransmission burst) — NOT time since any send, or a lossy bulk transfer keeps resetting
  // it with new (dropped) segments and the hole is never retransmitted.
  private rtoStartMs = 0;
  private unacked: { seq: number; flags: number; payload: Uint8Array }[] = [];
  private pending: Uint8Array[] = [];   // bridge bytes waiting for window
  private finQueued = false;
  private cancelTimer: (() => void) | null = null;

  private hostIp: Uint8Array;      // 10.0.0.3 for this flow (we impersonate the broker addr)
  private deviceIp: Uint8Array;
  private listenPort: number;
  private sendIp: (packet: Uint8Array) => void;
  private events: TcpSpliceEvents;

  constructor(
    hostIp: Uint8Array,
    deviceIp: Uint8Array,
    listenPort: number,
    sendIp: (packet: Uint8Array) => void,
    events: TcpSpliceEvents,
  ) {
    this.hostIp = hostIp;
    this.deviceIp = deviceIp;
    this.listenPort = listenPort;
    this.sendIp = sendIp;
    this.events = events;
  }

  /** Feed a TCP segment addressed to the broker IP. */
  handle(data: Uint8Array): void {
    const seg = parseTcp(data);
    if (!seg || seg.dstPort !== this.listenPort) return;

    if (seg.flags & RST) return this.abort(false);

    if (this.state === 'closed') {
      if (!(seg.flags & SYN)) return;
      this.devPort = seg.srcPort;
      this.rcvNxt = add32(seg.seq, 1);
      const iss = new Uint32Array(1);
      crypto.getRandomValues(iss);
      this.sndUna = iss[0];
      this.sndNxt = add32(iss[0], 1);
      this.peerWindow = seg.window;
      // SYN-ACK with an MSS option.
      this.emit(iss[0], SYN | ACK, new Uint8Array(0), new Uint8Array([2, 4, (MSS >> 8) & 0xff, MSS & 0xff]));
      this.state = 'syn-rcvd';
      this.startTimer();
      return;
    }

    if (seg.srcPort !== this.devPort) return;
    const prevWindow = this.peerWindow;
    this.peerWindow = seg.window;

    // Process their ACK of our data.
    if (seg.flags & ACK) {
      if (seqLt(this.sndUna, seg.ack) && seqLe(seg.ack, this.sndNxt)) {
        this.sndUna = seg.ack;
        this.retries = 0;
        this.dupAcks = 0;
        this.rtoStartMs = Date.now();
        while (this.unacked.length) {
          const first = this.unacked[0];
          const len = first.payload.length + (first.flags & (SYN | FIN) ? 1 : 0);
          if (seqLe(add32(first.seq, len), seg.ack)) this.unacked.shift();
          else break;
        }
        if (this.state === 'syn-rcvd') {
          this.state = 'established';
          this.events.onOpen();
        }
        if (this.state === 'last-ack' && this.sndUna === this.sndNxt) return this.abort(true);
        this.flushPending();
      } else if (
        seg.ack === this.sndUna &&
        this.unacked.length > 0 &&
        seg.payload.length === 0 &&
        seg.window === prevWindow &&   // a window update is flow control, not a loss signal
        !(seg.flags & (SYN | FIN))
      ) {
        // Duplicate ACK: the device is stuck at a hole and dropping everything we send past it
        // (in-order-only receive). Waiting out the RTO here is what starved bulk transfers —
        // fast-retransmit the hole (and a go-back-N burst behind it) instead.
        if (++this.dupAcks >= DUP_ACK_FAST_RETRANSMIT) {
          this.dupAcks = 0;
          this.goBackN();
        }
      }
      // Pure window update (same ack, new window): the device consumed its buffer — e.g. an OTA
      // flash write completed — and is reopening flow. Nothing else will ever trigger sending
      // here: with everything sent already acked there is no unacked segment for the RTO to
      // resend, so ignoring this ACK deadlocked bulk transfers until the device's HTTP read
      // timed out (the wired-OTA ~8 KB stall).
      if (seg.window !== prevWindow) this.flushPending();
    }

    if (this.state !== 'established') return;

    // In-order data only; anything else is re-ACKed so the device retransmits.
    if (seg.payload.length > 0) {
      if (seg.seq === this.rcvNxt) {
        this.rcvNxt = add32(this.rcvNxt, seg.payload.length);
        this.events.onData(seg.payload);
        this.sendAck();
      } else {
        this.sendAck();
        return;
      }
    }

    if (seg.flags & FIN && seg.seq === this.rcvNxt) {
      this.rcvNxt = add32(this.rcvNxt, 1);
      this.finQueued = true;         // ACK their FIN and answer with ours once our queue drains
      this.flushPending();
    }
  }

  /** Bytes arriving from the bridge (the real broker) for the device. */
  push(data: Uint8Array): void {
    for (let i = 0; i < data.length; i += MSS) this.pending.push(data.slice(i, i + MSS));
    this.flushPending();
  }

  /** The bridge lost the broker: finish sending, then FIN. */
  closeFromBridge(): void {
    this.finQueued = true;
    this.flushPending();
  }

  destroy(): void {
    this.stopTimer();
    this.state = 'closed';
  }

  private flushPending(): void {
    if (this.state !== 'established' && this.state !== 'last-ack') return;
    const inflight = () => (this.sndNxt - this.sndUna) >>> 0;
    // peerWindow is always learned (the SYN carries it); 0 means a genuinely closed window —
    // send nothing and wait for the window-update ACK, which calls back into here.
    while (
      this.pending.length &&
      inflight() + this.pending[0].length <= Math.min(this.peerWindow, MAX_INFLIGHT)
    ) {
      const chunk = this.pending.shift()!;
      this.emit(this.sndNxt, PSH | ACK, chunk);
      this.sndNxt = add32(this.sndNxt, chunk.length);
    }
    if (this.finQueued && this.pending.length === 0 && this.state === 'established') {
      this.emit(this.sndNxt, FIN | ACK, new Uint8Array(0));
      this.sndNxt = add32(this.sndNxt, 1);
      this.state = 'last-ack';
      this.events.onClose();
    }
  }

  private sendAck(): void {
    this.transmit(this.sndNxt, ACK, new Uint8Array(0), undefined, false);
  }

  /** Send and remember for retransmission. */
  private emit(seq: number, flags: number, payload: Uint8Array, options?: Uint8Array): void {
    this.unacked.push({ seq, flags, payload });
    if (this.unacked.length === 1) this.rtoStartMs = Date.now(); // clock starts with the oldest
    this.transmit(seq, flags, payload, options, false);
  }

  /** Retransmit from the oldest unacked segment forward (go-back-N burst). */
  private goBackN(): void {
    let sent = 0;
    for (const seg of this.unacked) {
      this.transmit(seg.seq, seg.flags, seg.payload, undefined, true);
      sent += seg.payload.length || 1;
      if (sent >= GO_BACK_BYTES) break;
    }
    this.rtoStartMs = Date.now();
  }

  private transmit(seq: number, flags: number, payload: Uint8Array, options?: Uint8Array, isRetransmit = false): void {
    void isRetransmit;
    const optLen = options ? Math.ceil(options.length / 4) * 4 : 0;
    const seg = new Uint8Array(20 + optLen + payload.length);
    seg[0] = (this.listenPort >>> 8) & 0xff;
    seg[1] = this.listenPort & 0xff;
    seg[2] = (this.devPort >>> 8) & 0xff;
    seg[3] = this.devPort & 0xff;
    seg[4] = (seq >>> 24) & 0xff; seg[5] = (seq >>> 16) & 0xff; seg[6] = (seq >>> 8) & 0xff; seg[7] = seq & 0xff;
    const ack = this.rcvNxt;
    seg[8] = (ack >>> 24) & 0xff; seg[9] = (ack >>> 16) & 0xff; seg[10] = (ack >>> 8) & 0xff; seg[11] = ack & 0xff;
    seg[12] = ((20 + optLen) / 4) << 4;
    seg[13] = flags;
    seg[14] = 0xff; seg[15] = 0xff;      // our receive window: plenty (we buffer in JS)
    if (options) seg.set(options, 20);
    seg.set(payload, 20 + optLen);
    const ck = transportChecksum(IPPROTO_TCP, this.hostIp, this.deviceIp, seg);
    seg[16] = (ck >>> 8) & 0xff;
    seg[17] = ck & 0xff;
    this.sendIp(buildIpv4(IPPROTO_TCP, this.hostIp, this.deviceIp, seg));
  }

  private startTimer(): void {
    if (this.cancelTimer) return;
    // linkScheduler (not setInterval): the RTO scan is what recovers a lost segment, and it must
    // keep firing while the tab is backgrounded — mid-OTA, a throttled scan stalls the download
    // until the device's HTTP client gives up (see pump.ts).
    this.cancelTimer = linkScheduler.every(250, () => {
      if (!this.unacked.length) return;
      // Exponential backoff: 1s, 2s, 4s … capped. A congested-but-alive peer (device mid
      // flash-write with a second flow saturating the serial pipe) ACKs eventually; hammering
      // retransmits into a full pipe only worsens the congestion that delayed the ACK.
      const rto = Math.min(RETRANSMIT_MS * 2 ** this.retries, RETRANSMIT_MAX_MS);
      if (Date.now() - this.rtoStartMs < rto) return;
      if (++this.retries > MAX_RETRIES) return this.abort(false);
      this.goBackN();
    });
  }

  private stopTimer(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  private abort(graceful: boolean): void {
    if (!graceful && this.state !== 'closed' && this.devPort) {
      this.transmit(this.sndNxt, RST | ACK, new Uint8Array(0));
    }
    this.stopTimer();
    // Fire onClose for EVERY flow teardown incl. the graceful last-ack completion — the owner
    // nulls its splice+bridge on this event, and a survivor left behind silently eats the next
    // flow's early bytes (its stale `bridge` is closed, so pre-bridge buffering never engages).
    const hadFlow = this.state !== 'closed';
    this.state = 'closed';
    this.unacked = [];
    this.pending = [];
    if (hadFlow) this.events.onClose();
  }
}
