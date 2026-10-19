// ipcp.ts — IPCP (RFC 1332) negotiator: hands the device its IP and points DNS at us.
//
// The device (lwIP) Conf-Reqs IP-Address 0.0.0.0 (and possibly DNS options); we Conf-Nak with the
// fixed link plan — device 10.0.0.2, host/DNS 10.0.0.1 (see manifest "link" section) — and Ack the
// re-request. VJ compression and anything exotic is rejected. Our own Conf-Req only asserts our
// address.

import { ip4, NegotiatorBase, PROTO_IPCP } from './cp';
import type { CpOption, OptionVerdict } from './cp';

const OPT_VJ = 2;
const OPT_IP_ADDRESS = 3;
const OPT_DNS1 = 129;
const OPT_DNS2 = 131;

function sameIp(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === 4 && b.length === 4 && a.every((v, i) => v === b[i]);
}

export class Ipcp extends NegotiatorBase {
  private hostIp: Uint8Array;
  private deviceIp: Uint8Array;

  constructor(
    hostIp: string,
    deviceIp: string,
    send: (proto: number, payload: Uint8Array) => void,
    onOpen: () => void,
    onClose: () => void,
  ) {
    super(PROTO_IPCP, send, onOpen, onClose);
    this.hostIp = ip4(hostIp);
    this.deviceIp = ip4(deviceIp);
  }

  protected judge(opt: CpOption): OptionVerdict {
    switch (opt.type) {
      case OPT_IP_ADDRESS:
        return sameIp(opt.value, this.deviceIp) ? { kind: 'ack' } : { kind: 'nak', value: this.deviceIp };
      case OPT_DNS1:
      case OPT_DNS2:
        return sameIp(opt.value, this.hostIp) ? { kind: 'ack' } : { kind: 'nak', value: this.hostIp };
      case OPT_VJ:
      default:
        return { kind: 'rej' };
    }
  }

  protected ourOptions(): CpOption[] {
    return [{ type: OPT_IP_ADDRESS, value: this.hostIp }];
  }
}
