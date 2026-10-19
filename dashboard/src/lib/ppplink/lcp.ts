// lcp.ts — LCP (RFC 1661) negotiator: the link-establishment half of WiredLink.
//
// We are the answering peer of the device's lwIP PPP client. Policy:
//  - accept MRU / ACCM / magic-number / protocol-field-compression / addr-ctrl-compression
//  - reject everything else (auth in particular: the link is a private USB cable and the real
//    security boundary is the device's end-to-end mTLS session to the broker)
//  - our own Conf-Req carries only a magic number
//  - answer Echo-Req so lwIP's LCP keepalive holds the link up
//  - terminate() sends Term-Req: this is the cut-the-cord signal that drops the device into its
//    serial config window (see arduino_onboard_wired.ino ppp_supervisor_task)

import {
  buildCp, CODE_ECHO_REQ, CODE_ECHO_REP, CODE_PROTO_REJ, CODE_TERM_ACK, CODE_TERM_REQ,
  NegotiatorBase, PROTO_LCP,
} from './cp';
import type { CpOption, CpPacket, OptionVerdict } from './cp';

const OPT_MRU = 1;
const OPT_ACCM = 2;
const OPT_MAGIC = 5;
const OPT_PFC = 7;
const OPT_ACFC = 8;

export class Lcp extends NegotiatorBase {
  private magic: Uint8Array<ArrayBuffer>;
  private termResolve: (() => void) | null = null;

  constructor(
    send: (proto: number, payload: Uint8Array) => void,
    onOpen: () => void,
    onClose: () => void,
  ) {
    super(PROTO_LCP, send, onOpen, onClose);
    this.magic = new Uint8Array(4);
    crypto.getRandomValues(this.magic);
  }

  protected judge(opt: CpOption): OptionVerdict {
    switch (opt.type) {
      case OPT_MRU:
      case OPT_ACCM:
      case OPT_MAGIC:
      case OPT_PFC:
      case OPT_ACFC:
        return { kind: 'ack' };
      default:
        return { kind: 'rej' };
    }
  }

  protected ourOptions(): CpOption[] {
    return [{ type: OPT_MAGIC, value: this.magic }];
  }

  protected handleExtra(pkt: CpPacket): void {
    switch (pkt.code) {
      case CODE_ECHO_REQ: {
        const data = new Uint8Array(Math.max(4, pkt.data.length));
        data.set(pkt.data);
        data.set(this.magic, 0); // reply must carry OUR magic
        this.send(this.proto, buildCp(CODE_ECHO_REP, pkt.id, data));
        return;
      }
      case CODE_TERM_ACK:
        if (this.termResolve) {
          this.termResolve();
          this.termResolve = null;
        }
        return;
    }
  }

  /** Tell the peer we don't speak a protocol (e.g. CCP) so it stops trying to negotiate it. */
  protoRej(rejProto: number, packet: Uint8Array): void {
    const data = new Uint8Array(2 + packet.length);
    data[0] = (rejProto >>> 8) & 0xff;
    data[1] = rejProto & 0xff;
    data.set(packet, 2);
    this.send(this.proto, buildCp(CODE_PROTO_REJ, this.sendId++, data));
  }

  /** Cut-the-cord: request link teardown; resolves on Term-Ack (or after a grace timeout). */
  terminate(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      this.termResolve = resolve;
      this.send(this.proto, buildCp(CODE_TERM_REQ, this.sendId++, new Uint8Array(0)));
      setTimeout(() => {
        if (this.termResolve) {
          this.termResolve = null;
          resolve(); // device tears down without acking us? proceed anyway
        }
      }, timeoutMs);
      this.stop();
    });
  }
}
