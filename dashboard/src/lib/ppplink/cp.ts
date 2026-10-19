// cp.ts — shared PPP control-protocol machinery (RFC 1661) for LCP/IPCP.
//
// Both LCP and IPCP exchange the same packet shape inside their PPP protocol:
//   [code 1B] [id 1B] [length 2B BE] [data...]      data = option TLVs for Conf-* codes
// and the same negotiation dance. NegotiatorBase implements the half we need as the "answering"
// peer of an lwIP client: judge the device's Conf-Req (Ack / Nak / Rej per option), and push our
// own minimal Conf-Req until it is acked. Subclasses supply the option policy.

import { linkScheduler } from './pump';

export const PROTO_LCP = 0xc021;
export const PROTO_IPCP = 0x8021;
export const PROTO_IPV4 = 0x0021;
// Private, device→host only: the firmware wraps each ESP_LOG line in a frame with this protocol so
// its serial console rides the live PPP link. High byte 0xC0 is even (the HDLC decoder parses it as
// a 2-byte proto); low byte 0xFF is odd (a valid PPP proto); 0xC0xx is link-control range, legal at
// any phase; unassigned by IANA. The host never sends it, so it never triggers a protocol-reject.
export const PROTO_CONSOLE = 0xc0ff;

export const CODE_CONF_REQ = 1;
export const CODE_CONF_ACK = 2;
export const CODE_CONF_NAK = 3;
export const CODE_CONF_REJ = 4;
export const CODE_TERM_REQ = 5;
export const CODE_TERM_ACK = 6;
export const CODE_CODE_REJ = 7;
export const CODE_PROTO_REJ = 8;
export const CODE_ECHO_REQ = 9;
export const CODE_ECHO_REP = 10;

export interface CpPacket {
  code: number;
  id: number;
  data: Uint8Array;
}

export interface CpOption {
  type: number;
  value: Uint8Array;
}

export function parseCp(payload: Uint8Array): CpPacket | null {
  if (payload.length < 4) return null;
  const len = (payload[2] << 8) | payload[3];
  if (len < 4 || len > payload.length) return null;
  return { code: payload[0], id: payload[1], data: payload.slice(4, len) };
}

export function buildCp(code: number, id: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = code;
  out[1] = id;
  out[2] = (out.length >>> 8) & 0xff;
  out[3] = out.length & 0xff;
  out.set(data, 4);
  return out;
}

export function parseOptions(data: Uint8Array): CpOption[] | null {
  const opts: CpOption[] = [];
  let i = 0;
  while (i < data.length) {
    if (i + 2 > data.length) return null;
    const len = data[i + 1];
    if (len < 2 || i + len > data.length) return null;
    opts.push({ type: data[i], value: data.slice(i + 2, i + len) });
    i += len;
  }
  return opts;
}

export function buildOptions(opts: CpOption[]): Uint8Array {
  const total = opts.reduce((n, o) => n + 2 + o.value.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const o of opts) {
    out[i] = o.type;
    out[i + 1] = 2 + o.value.length;
    out.set(o.value, i + 2);
    i += 2 + o.value.length;
  }
  return out;
}

export function ip4(addr: string): Uint8Array {
  return new Uint8Array(addr.split('.').map((s) => parseInt(s, 10)));
}

export type OptionVerdict =
  | { kind: 'ack' }
  | { kind: 'nak'; value: Uint8Array }  // counter-proposal for this option
  | { kind: 'rej' };

const RESEND_MS = 500;
const MAX_RESENDS = 20;

/**
 * The answering half of a CP negotiation. Drives to "open" when (a) we Conf-Ack'd the device's
 * request and (b) the device Conf-Ack'd ours.
 */
export abstract class NegotiatorBase {
  protected sendId = 1;
  protected proto: number;
  protected send: (proto: number, payload: Uint8Array) => void;
  private onOpen: () => void;
  private onClose: () => void;
  private theirsAcked = false;
  private oursAcked = false;
  private resends = 0;
  private cancelResend: (() => void) | null = null;
  opened = false;

  constructor(
    proto: number,
    send: (proto: number, payload: Uint8Array) => void,
    onOpen: () => void,
    onClose: () => void,
  ) {
    this.proto = proto;
    this.send = send;
    this.onOpen = onOpen;
    this.onClose = onClose;
  }

  /** Option policy: how to answer each option in the device's Conf-Req. */
  protected abstract judge(opt: CpOption): OptionVerdict;
  /** The options of our own Conf-Req. */
  protected abstract ourOptions(): CpOption[];

  start(): void {
    this.stopTimer();
    this.theirsAcked = false;
    this.oursAcked = false;
    this.opened = false;
    this.resends = 0;
    this.sendConfReq();
    // linkScheduler (not setInterval): the resend must keep firing while the tab is backgrounded —
    // renegotiation across an OTA reboot depends on it (see pump.ts).
    this.cancelResend = linkScheduler.every(RESEND_MS, () => {
      if (this.oursAcked) return this.stopTimer();
      if (++this.resends > MAX_RESENDS) return this.stopTimer();
      this.sendConfReq();
    });
  }

  stop(): void {
    this.stopTimer();
    this.opened = false;
  }

  handle(pkt: CpPacket): void {
    switch (pkt.code) {
      case CODE_CONF_REQ: {
        if (this.opened) {
          // A Conf-Req on an open link means the peer RESTARTED (e.g. the device rebooted after
          // applying its rollover cert). RFC 1661: fall back to negotiation — re-assert our own
          // Conf-Req (the rebooted peer has no memory of acking it) and tell the owner so it can
          // tear down dependent state (flows, IPCP). Without this the peer waits forever for a
          // Conf-Req that never comes and PPP never re-opens — the historic CLAIMED-reconnect gap.
          this.opened = false;
          this.start();
          this.onClose();
        }
        const opts = parseOptions(pkt.data);
        if (!opts) return;
        const rej = opts.filter((o) => this.judge(o).kind === 'rej');
        if (rej.length) {
          this.send(this.proto, buildCp(CODE_CONF_REJ, pkt.id, buildOptions(rej)));
          return;
        }
        const naks: CpOption[] = [];
        for (const o of opts) {
          const v = this.judge(o);
          if (v.kind === 'nak') naks.push({ type: o.type, value: v.value });
        }
        if (naks.length) {
          this.send(this.proto, buildCp(CODE_CONF_NAK, pkt.id, buildOptions(naks)));
          return;
        }
        this.send(this.proto, buildCp(CODE_CONF_ACK, pkt.id, pkt.data));
        this.theirsAcked = true;
        this.checkOpen();
        return;
      }
      case CODE_CONF_ACK:
        this.oursAcked = true;
        this.stopTimer();
        this.checkOpen();
        return;
      case CODE_CONF_NAK:
      case CODE_CONF_REJ:
        // Our request is minimal; adopt nothing, just re-assert it.
        this.sendConfReq();
        return;
      case CODE_TERM_REQ:
        this.send(this.proto, buildCp(CODE_TERM_ACK, pkt.id, new Uint8Array(0)));
        this.stop();
        this.onClose();
        return;
      default:
        this.handleExtra(pkt);
    }
  }

  /** LCP overrides this for echo/terminate handling; IPCP ignores. */
  protected handleExtra(pkt: CpPacket): void {
    void pkt;
  }

  protected sendConfReq(): void {
    this.send(this.proto, buildCp(CODE_CONF_REQ, this.sendId++, buildOptions(this.ourOptions())));
  }

  private checkOpen(): void {
    if (this.theirsAcked && this.oursAcked && !this.opened) {
      this.opened = true;
      this.onOpen();
    }
  }

  private stopTimer(): void {
    if (this.cancelResend !== null) {
      this.cancelResend();
      this.cancelResend = null;
    }
  }
}
