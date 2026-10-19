// index.ts — WiredLink: the browser-resident host end of the device's PPPoS link.
//
// Owns the Web Serial port after flashing (the same reopen pattern as useEspFlasher's
// monitorSerial) and runs the whole wired data path:
//
//   serial bytes ⇄ HDLC ⇄ { LCP, IPCP, IPv4 ⇄ { DNS :53, SNTP :123, TCP ⇄ per-flow WS bridges } }
//
// TCP is MULTI-FLOW: the MQTT session to the broker (:8883, dialed by IP literal) plus any
// hostname-resolved flows — in practice the OTA artifact download from Supabase Storage (:443).
// DnsMap hands each hostname a distinct synthetic IP so the flow router can recover the true
// destination at SYN time and ask /api/link-token for a bridge to exactly that host:port (the
// destination is signed into the bridge token — the bridge is not an open proxy).
//
// Also implements the cut-the-cord handoff: LCP Terminate-Req drops the device into its serial
// config window, then WiFi creds go over as a plain "NFF+CFG <b64> <b64|->" line (see
// arduino_onboard_wired.ino ppp_supervisor_task).

import { BrokerBridge } from './bridge';
import { ip4, parseCp, PROTO_CONSOLE, PROTO_IPCP, PROTO_IPV4, PROTO_LCP } from './cp';
import { answerDns, DnsMap, queryName } from './dns';
import { encodeFrame, HdlcDecoder } from './hdlc';
import { Ipcp } from './ipcp';
import { buildUdp, IPPROTO_TCP, IPPROTO_UDP, parseIpv4, parseUdp } from './ipv4';
import { Lcp } from './lcp';
import { answerNtp } from './ntp';
import { acquirePump, linkScheduler, releasePump } from './pump';
import { TcpSplice } from './tcp';

export type WiredLinkState =
  | 'negotiating'   // LCP/IPCP in progress
  | 'link-up'       // device has an IP over the cable
  | 'tunneled'      // broker TCP flow spliced through the bridge
  | 'handoff'       // cut-the-cord in progress
  | 'closed'
  | 'error';

// The transport-independent part of a wired link (manifest `link` section). Persisted so a page
// reload can resume the link on an already-granted port without re-flashing (see linkStore).
export interface WiredLinkPlan {
  kind: 'pppos';
  baud: number;
  hostIp: string;
  deviceIp: string;
  brokerIp: string;
  brokerPort: number;
}

export interface WiredLinkOptions {
  port: SerialPort;
  baud: number;              // manifest link.baud (460800)
  hostIp: string;            // 10.0.0.1
  deviceIp: string;          // 10.0.0.2
  brokerIp: string;          // 10.0.0.3 (synthetic fallback for unparseable DNS queries)
  brokerPort: number;        // 8883
  /** Called per TCP flow; dst is '' for the broker or 'host:port' for a DNS-resolved flow.
      Returns the (token-bearing) WS URL of the fleet bridge for that destination. */
  bridgeUrl: (dst: string) => Promise<string>;
  onState: (state: WiredLinkState) => void;
  onLog?: (line: string) => void;
  /** Device serial-console text, demultiplexed from the PROTO_CONSOLE (0xC0FF) frames the firmware
      sends over the live link. Feeds the dashboard Serial Monitor. */
  onConsole?: (text: string) => void;
}

// One spliced TCP connection: device ⇄ splice ⇄ (preBridge until the token arrives) ⇄ WS bridge.
interface WiredFlow {
  splice: TcpSplice;
  bridge: BrokerBridge | null;
  preBridge: Uint8Array[];
  isBroker: boolean;
}

export class WiredLink {
  state: WiredLinkState = 'closed';

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private decoder: HdlcDecoder;
  private lcp: Lcp;
  private ipcp: Ipcp | null = null;
  private flows = new Map<string, WiredFlow>();
  private dnsMap = new DnsMap();
  private deviceIpB: Uint8Array;
  private brokerIpB: Uint8Array;
  private mode: 'ppp' | 'line' = 'ppp';
  private lineBuf = '';
  private onLine: ((line: string) => void) | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private stopped = false;
  private probeCancel: (() => void) | null = null;
  private probeBytes = 0;         // raw bytes seen since the probe (re)armed — "alive but booting"
  private probeStartMs = 0;
  private pumpHeld = false;
  private opts: WiredLinkOptions;

  constructor(opts: WiredLinkOptions) {
    this.opts = opts;
    this.deviceIpB = ip4(opts.deviceIp);
    this.brokerIpB = ip4(opts.brokerIp);
    this.decoder = new HdlcDecoder((f) => this.onFrame(f.proto, f.payload));
    this.lcp = new Lcp(
      (proto, payload) => this.sendFrame(proto, payload),
      () => this.onLcpOpen(),
      () => {
        // Device closed or RESTARTED the link (e.g. reboot after applying its rollover cert):
        // drop everything device-session-scoped; LCP re-negotiation is already underway and
        // onLcpOpen will rebuild IPCP + flows.
        this.log('LCP down (device closed or restarted) — renegotiating');
        this.closeFlow();
        this.ipcp?.stop();
        this.ipcp = null;
        if (this.state !== 'handoff' && this.state !== 'closed') this.setState('negotiating');
      },
    );
  }

  /**
   * `reset` decides what happens to the device's EN pin on open:
   *  - 'always' — deliberate EN pulse (clean cold boot). Right after a flash, where esptool just
   *    reset the chip anyway and determinism beats continuity.
   *  - 'probe'  — do NOT reset a device that is already alive: bring PPP up and let the LCP
   *    Conf-Req (resent every 500 ms) double as a liveness probe. Any decoded HDLC frame within
   *    the watchdog window proves the device is running (a live lwIP peer answers within tens of
   *    ms; a stale open session renegotiates per RFC 1661) — the pulse is skipped and an
   *    in-flight OTA survives the re-attach. No frame in 2 s (crashed firmware, ROM bootloader,
   *    wrong-baud boot noise never forms a valid frame) → fall back to the pulse, which is the
   *    correct un-wedge remedy there anyway.
   */
  async open(reset: 'always' | 'probe'): Promise<void> {
    const { port, baud } = this.opts;
    // Tick pump first: every link timer below (LCP resends, TCP RTO scans, the probe watchdog)
    // rides linkScheduler, which only advances while the pump worker ticks.
    if (!this.pumpHeld) { acquirePump(); this.pumpHeld = true; }
    if (!port.readable) await port.open({ baudRate: baud, bufferSize: 65536 });
    // CP210x boards route RTS→EN and DTR→GPIO0 through the auto-program circuit, and the OS
    // asserts both to driver defaults DURING port.open() — an ordering race that can reset the
    // chip mid-run or, worse, wedge it into the ROM bootloader (EN released while GPIO0 still
    // low: no app, no PPP, bench-proven). 'always' doesn't leave boot state to that coin flip:
    // it pulses a DELIBERATE clean reset — RTS alone pulls EN low while GPIO0 stays high, so
    // releasing it always yields a normal flash boot (and un-wedges a chip the transient already
    // caught). Cost: the device re-boots (~25 s incl. its WiFi-first window). 'probe' instead
    // drives both signals inactive (the benign state — if the open() transient did glitch the
    // chip, both-false lets it finish a normal flash boot) and arms the liveness watchdog.
    try {
      if (reset === 'always') {
        await port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise((r) => setTimeout(r, 100));
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        this.log('pulsed EN reset — device cold-boots into a clean state');
      } else {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        this.probeBytes = 0;
        this.probeStartMs = performance.now();
        this.probeCancel = linkScheduler.after(2000, () => this.probeExpired());
        this.log('probing for a live link before touching EN…');
      }
    } catch { /* not all adapters support signals; the old behavior was a plain open anyway */ }
    // The reader is acquired (and re-acquired after noise errors) inside readLoop.
    this.writer = port.writable!.getWriter();
    this.setState('negotiating');
    this.lcp.start();
    void this.readLoop();
  }

  // Probe watchdog fired with no decoded frame yet. Distinguish "silent line" from "device busy
  // booting": ANY raw bytes (even wrong-baud boot noise that never forms a valid frame) prove the
  // device is alive and mid-something — pulsing EN then is what killed a 1.0.24 OTA trial on the
  // bench (rst=1 during pending-verify → bootloader rollback). Keep extending the window while
  // bytes trickle in (a boot needs up to ~30 s incl. the WiFi-first window); only a genuinely
  // silent line — crashed firmware, ROM-wedged chip, held in reset — earns the pulse.
  private probeExpired(): void {
    this.probeCancel = null;
    if (this.stopped) return;
    const sinceStart = performance.now() - this.probeStartMs;
    if (this.probeBytes > 0 && sinceStart < 45000) {
      this.probeBytes = 0;
      this.probeCancel = linkScheduler.after(3000, () => this.probeExpired());
      this.log('probe: bytes but no frames yet (device booting?) — extending the window');
      return;
    }
    this.log(`probe: silence for ${Math.round(sinceStart / 1000)}s — pulsing EN`);
    void (async () => {
      try {
        await this.opts.port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise((r) => setTimeout(r, 100));
        await this.opts.port.setSignals({ dataTerminalReady: false, requestToSend: false });
        this.log('pulsed EN reset — device cold-boots into a clean state');
      } catch { /* adapter without signal support: nothing to pulse, LCP restart still applies */ }
      if (!this.stopped) this.lcp.start();
    })();
  }

  /**
   * Cut-the-cord, two-phase: ARM the device's config window explicitly, then (and only then)
   * push the WiFi creds through it. Phase 1 sends the raw line "NFF+LISTEN?" — the firmware's
   * rx task scans the inbound byte stream for it, so it works whether or not the LCP terminate
   * has been processed — and waits for "NFF+LISTENING". Phase 2 sends
   * `NFF+CFG <b64 ssid> <b64 pass|-> [<b64 broker>]` and waits for NFF+OK. The device only ever
   * leaves the wired path on a valid phase-2 config; an accidental link drop can't trigger it.
   * `broker` is the fleet's REAL address (host:port) for WiFi mode — over WiFi the device can't
   * resolve the wired path's synthetic broker hostname.
   */
  async sendWifiCreds(ssid: string, pass: string, broker?: string, timeoutMs = 10000): Promise<boolean> {
    this.setState('handoff');
    this.closeFlow();
    await this.lcp.terminate();
    this.ipcp?.stop();
    this.mode = 'line';
    this.lineBuf = '';

    const b64 = (s: string) => {
      const bytes = new TextEncoder().encode(s);
      return bytes.length ? btoa(String.fromCharCode(...bytes)) : '-';
    };

    // Phase 1: arm, retrying once a second (the device answers within ms once its rx task sees
    // the line; retries cover boot-noise windows). Foreground user-gesture flow — plain timers.
    const armed = await new Promise<boolean>((resolve) => {
      let tries = 0;
      const sendArm = () => this.write(new TextEncoder().encode('NFF+LISTEN?\n'));
      const iv = setInterval(() => {
        if (++tries >= 8) { cleanup(false); return; }
        sendArm();
      }, 1000);
      const cleanup = (ok: boolean) => { clearInterval(iv); this.onLine = null; resolve(ok); };
      // includes(), not startsWith(): the ack can share its line with residue from the device's
      // own LCP Terminate frame (HDLC never emits '\n' inside a frame, so the binary tail lands
      // as a prefix of the next line).
      this.onLine = (line) => { if (line.includes('NFF+LISTENING')) cleanup(true); };
      sendArm();
    });
    if (!armed) {
      this.log('handoff: device never answered NFF+LISTEN? — aborting (firmware without the config window?)');
      return false;
    }

    // Phase 2: the credentials themselves.
    const ack = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.onLine = null; resolve(false); }, timeoutMs);
      this.onLine = (line) => {
        if (line.includes('NFF+OK')) { clearTimeout(timer); this.onLine = null; resolve(true); }
        else if (line.includes('NFF+ERR')) { clearTimeout(timer); this.onLine = null; resolve(false); }
      };
    });
    const brokerField = broker ? ` ${b64(broker)}` : '';
    this.write(new TextEncoder().encode(`NFF+CFG ${b64(ssid)} ${b64(pass)}${brokerField}\n`));
    return ack;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.probeCancel) { this.probeCancel(); this.probeCancel = null; }
    this.lcp.stop();
    this.ipcp?.stop();
    this.closeFlow();
    try { await this.reader?.cancel(); } catch { /* torn down */ }
    try { this.reader?.releaseLock(); } catch { /* torn down */ }
    try { await this.writeChain; this.writer?.releaseLock(); } catch { /* torn down */ }
    if (this.pumpHeld) { releasePump(); this.pumpHeld = false; }
    this.setState('closed');
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async readLoop(): Promise<void> {
    // Web Serial surfaces line NOISE as non-fatal stream errors: the pending read rejects and
    // that ReadableStream dies, but the port stays open and `port.readable` returns a fresh
    // stream to resume on. Noise here is the NORM, not the exception — opening the port resets
    // the ESP32 (DTR/RTS transient), which then boot-logs at 115200 into our 460800 session,
    // and stray console prints can land mid-PPP too. A loop that treats the first framing error
    // as fatal leaves a ZOMBIE link (port held open, PPP forever deaf — bench-diagnosed), so:
    // re-acquire the reader and keep reading; only stop()/unplug (readable gone) ends the loop.
    while (!this.stopped) {
      const readable = this.opts.port.readable;
      if (!readable) break;
      try {
        this.reader = readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (this.stopped) return;            // cancelled by close() — fully torn down
          if (done) {
            // The stream closed but the port is still open. A CP2102-class adapter does NOT
            // re-enumerate when the ESP32 resets, so an OTA reboot / re-flash ends the current
            // ReadableStream (done=true) while port.readable stays valid and hands us a fresh
            // one. That is recovery, not teardown — break to the outer while, which re-acquires
            // a reader in place. (Only stop()/unplug ends the loop.) Must NOT re-open the port
            // or re-pulse DTR/RTS here: that would reset the chip and restart the OTA cycle.
            this.log('serial stream closed (device reboot?) — re-acquiring reader');
            break;
          }
          if (!value) continue;
          if (this.probeCancel) this.probeBytes += value.length;   // liveness signal for the probe
          if (this.mode === 'ppp') {
            this.decoder.feed(value);
          } else {
            this.lineBuf += new TextDecoder().decode(value);
            let nl;
            while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
              const line = this.lineBuf.slice(0, nl).trim();
              this.lineBuf = this.lineBuf.slice(nl + 1);
              if (line) this.onLine?.(line);
            }
          }
        }
      } catch (e) {
        if (this.stopped) return;
        this.log(`serial read error (recovering): ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        try { this.reader?.releaseLock(); } catch { /* stream already errored/detached */ }
      }
      // Brief backoff before re-acquiring (done or error recovery): a stream that closes
      // instantly during the reboot window must not hot-spin the loop. Rides the tick pump so
      // reader re-acquire keeps its cadence in a backgrounded tab (an OTA reboot mid-download
      // closes the stream exactly then).
      if (!this.stopped) await linkScheduler.sleep(50);
    }
    if (!this.stopped) {
      this.log('serial readable gone (device unplugged?)');
      this.setState('error');
    }
  }

  private onFrame(proto: number, payload: Uint8Array): void {
    // Any FCS-valid frame proves the device is alive and running PPP (boot noise at the wrong
    // baud never decodes into one) — a pending liveness probe is satisfied, no EN pulse needed.
    if (this.probeCancel) {
      this.probeCancel();
      this.probeCancel = null;
      this.log('probe: link is live — skipping EN pulse');
    }
    switch (proto) {
      case PROTO_LCP: {
        const pkt = parseCp(payload);
        if (pkt) this.lcp.handle(pkt);
        return;
      }
      case PROTO_IPCP: {
        const pkt = parseCp(payload);
        if (pkt && this.ipcp) this.ipcp.handle(pkt);
        return;
      }
      case PROTO_IPV4:
        this.onIp(payload);
        return;
      case PROTO_CONSOLE:
        // Device serial console rides the link — surface the UTF-8 text, don't reject.
        this.opts.onConsole?.(new TextDecoder().decode(payload));
        return;
      default:
        // CCP and friends: refuse once, lwIP stops asking.
        this.lcp.protoRej(proto, payload);
    }
  }

  private onLcpOpen(): void {
    this.log('LCP open');
    this.ipcp = new Ipcp(
      this.opts.hostIp,
      this.opts.deviceIp,
      (proto, payload) => this.sendFrame(proto, payload),
      () => { this.log(`IPCP open — device is ${this.opts.deviceIp}`); this.setState('link-up'); },
      () => this.log('IPCP closed by device'),
    );
    this.ipcp.start();
  }

  private onIp(packet: Uint8Array): void {
    const ip = parseIpv4(packet);
    if (!ip) return;

    if (ip.proto === IPPROTO_UDP) {
      const udp = parseUdp(ip.payload);
      if (!udp) return;
      let reply: Uint8Array | null = null;
      if (udp.dstPort === 53) {
        const name = queryName(udp.payload);
        reply = answerDns(udp.payload, name ? this.dnsMap.ipFor(name) : this.brokerIpB);
      } else if (udp.dstPort === 123) {
        reply = answerNtp(udp.payload);
      }
      if (reply) {
        this.sendFrame(PROTO_IPV4, buildUdp(ip.dst, ip.src, udp.dstPort, udp.srcPort, reply));
      }
      return;
    }

    if (ip.proto === IPPROTO_TCP) {
      if (ip.payload.length < 4) return;
      const srcPort = (ip.payload[0] << 8) | ip.payload[1];
      const dstPort = (ip.payload[2] << 8) | ip.payload[3];
      const key = `${srcPort}:${ip.dst.join('.')}:${dstPort}`;
      let flow = this.flows.get(key);
      if (!flow) {
        // Recover the true destination: broker port (dialed by IP literal) or a hostname the
        // device previously resolved through our DNS. Anything else has nowhere to go.
        let dst: string | null = null;
        if (dstPort === this.opts.brokerPort) {
          dst = '';
        } else {
          const host = this.dnsMap.lookup(ip.dst);
          if (host) dst = `${host}:${dstPort}`;
        }
        if (dst === null) {
          this.log(`dropping flow to unknown destination ${ip.dst.join('.')}:${dstPort}`);
          return;
        }
        if (dst === '') {
          // One broker connection per device. A new broker SYN (fresh ephemeral src port) means the
          // device abandoned any prior operational connection — a reboot or an MQTT reconnect. Evict
          // stale broker flows so two never overlap: a second connection presenting the same MQTT
          // client-id makes the broker do session-takeover, which shows up as connect/disconnect
          // flapping and a device that never settles online.
          for (const k of [...this.flows.keys()]) {
            const f = this.flows.get(k);
            if (f && f.isBroker && k !== key) this.destroyFlow(k);
          }
        }
        flow = this.createFlow(key, ip.dst.slice(), dstPort, dst);
        this.flows.set(key, flow);
      }
      flow.splice.handle(ip.payload);
    }
  }

  private createFlow(key: string, dstIp: Uint8Array, dstPort: number, dst: string): WiredFlow {
    const label = dst === '' ? 'broker' : dst;
    const flow: WiredFlow = { splice: null as unknown as TcpSplice, bridge: null, preBridge: [], isBroker: dst === '' };
    flow.splice = new TcpSplice(dstIp, this.deviceIpB, dstPort,
      (pkt) => this.sendFrame(PROTO_IPV4, pkt), {
        onOpen: () => {
          this.log(`device TCP open → ${label} — connecting bridge`);
          flow.preBridge = [];
          void this.opts.bridgeUrl(dst).then((url) => {
            if (!this.flows.has(key)) return; // flow died while we fetched the token
            flow.bridge = new BrokerBridge(url, {
              onData: (data) => flow.splice.push(data),
              onClose: () => { this.log(`bridge closed (${label})`); flow.splice.closeFromBridge(); },
            });
            // Bytes buffered since the handshake (TLS ClientHello lands within milliseconds,
            // long before /api/link-token returns — dropping it stalls TLS forever).
            for (const chunk of flow.preBridge) flow.bridge.send(chunk);
            flow.preBridge = [];
            if (flow.isBroker) this.setState('tunneled');
          }).catch((e) => {
            this.log(`bridge connect failed (${label}): ${e instanceof Error ? e.message : String(e)}`);
            this.destroyFlow(key);
          });
        },
        onData: (data) => {
          if (flow.bridge) flow.bridge.send(data);
          else flow.preBridge.push(data.slice());
        },
        onClose: () => {
          this.log(`device TCP closed (${label})`);
          flow.bridge?.close();
          flow.bridge = null;
          this.flows.delete(key);   // next SYN (MQTT reconnect / next download) starts fresh
          if (flow.isBroker && this.state === 'tunneled') this.setState('link-up');
        },
      });
    return flow;
  }

  private destroyFlow(key: string): void {
    const flow = this.flows.get(key);
    if (!flow) return;
    this.flows.delete(key);
    flow.bridge?.close();
    flow.bridge = null;
    flow.splice.destroy();
  }

  private closeFlow(): void {
    for (const key of [...this.flows.keys()]) this.destroyFlow(key);
  }

  private sendFrame(proto: number, payload: Uint8Array): void {
    this.write(encodeFrame(proto, payload));
  }

  private write(bytes: Uint8Array): void {
    // Serialize writes: Web Serial writers reject concurrent write(). A TX-side stream error used
    // to kill the writer PERMANENTLY while the read side stayed healthy (readLoop re-acquires
    // readers; nothing re-acquired writers) — the wedge presents as "console lines still arrive
    // but DNS/ACKs go unanswered" (bench-diagnosed: outbound-dead link, device spams getaddrinfo
    // 202). Recover symmetrically: on error, release the dead writer; the next write lazily takes
    // a fresh one from port.writable (which, like port.readable, hands out a new stream after a
    // non-fatal error once the old lock is released). The errored frame is dropped — PPP/TCP
    // retransmission covers it.
    this.writeChain = this.writeChain
      .then(() => {
        if (!this.writer) {
          const writable = this.opts.port.writable;
          if (!writable) return;               // unplugged — readLoop reports it
          this.writer = writable.getWriter();
          this.log('serial writer re-acquired');
        }
        // Write watchdog: bench-observed TX wedge — one write() neither resolves nor rejects for
        // ~6 MINUTES (USB/driver pipe stall), and since the chain is serialized, every outbound
        // frame queues behind it: DNS answers, TCP ACKs, SYN-ACKs all go silent while inbound
        // still flows (device logs `getaddrinfo 202`, MQTT `No PING_RESP`). A frame at 460 kbaud
        // takes ~30 ms — 5 s of not settling means the pipe is wedged, not busy. abort() forces
        // the hung write to reject so the catch below drops the writer and the next write
        // re-acquires a fresh stream; the lost frames are PPP/TCP-retransmitted.
        const w = this.writer;
        const cancelWatchdog = linkScheduler.after(5000, () => {
          this.log('serial write hung >5s — aborting writer to unwedge TX');
          void w.abort().catch(() => { /* already errored */ });
        });
        return w.write(bytes).finally(cancelWatchdog);
      })
      .catch((e) => {
        if (this.stopped) return;
        this.log(`serial write error (writer dropped, will re-acquire): ${e instanceof Error ? e.message : String(e)}`);
        try { this.writer?.releaseLock(); } catch { /* stream already errored/detached */ }
        this.writer = null;
      });
  }

  private setState(s: WiredLinkState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }

  private log(line: string): void {
    this.opts.onLog?.(`[wired] ${line}`);
  }
}
