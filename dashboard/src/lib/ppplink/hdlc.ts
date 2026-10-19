// hdlc.ts — PPP-in-HDLC-like framing for PPPoS (RFC 1662), browser side.
//
// Wire format of one frame (before byte-stuffing):
//   [0xFF addr] [0x03 ctrl] [proto (1-2 bytes)] [payload...] [FCS-16 little-endian]
// delimited by 0x7E flags. Bytes 0x7E/0x7D (and, on TX, all controls < 0x20 — safe under any
// negotiated ACCM) are escaped as 0x7D, byte^0x20. FCS is CRC-16/X.25 over addr..payload,
// transmitted complemented; a whole received frame including FCS sums to GOOD_FCS.
//
// The decoder is a streaming byte-sink: feed() arbitrary serial chunks, get whole verified
// frames out. It tolerates address/control-field and protocol-field compression (lwIP may
// negotiate both), and silently drops inter-frame noise and bad-FCS frames (counting them).

export const FLAG = 0x7e;
export const ESCAPE = 0x7d;
const GOOD_FCS = 0xf0b8;

// CRC-16/X.25 table (poly 0x8408, reflected).
const FCS_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let b = 0; b < 8; b++) v = (v & 1) ? (v >>> 1) ^ 0x8408 : v >>> 1;
    t[i] = v;
  }
  return t;
})();

export function fcs16(data: Uint8Array, start = 0, end = data.length): number {
  let fcs = 0xffff;
  for (let i = start; i < end; i++) fcs = ((fcs >>> 8) ^ FCS_TABLE[(fcs ^ data[i]) & 0xff]) & 0xffff;
  return fcs;
}

export interface HdlcFrame {
  proto: number;
  payload: Uint8Array;
}

/** Encode one PPP frame. Always emits uncompressed addr/ctrl + 2-byte proto (always legal). */
export function encodeFrame(proto: number, payload: Uint8Array): Uint8Array {
  const raw = new Uint8Array(4 + payload.length + 2);
  raw[0] = 0xff;
  raw[1] = 0x03;
  raw[2] = (proto >>> 8) & 0xff;
  raw[3] = proto & 0xff;
  raw.set(payload, 4);
  const fcs = fcs16(raw, 0, raw.length - 2) ^ 0xffff;
  raw[raw.length - 2] = fcs & 0xff;        // FCS is little-endian on the wire
  raw[raw.length - 1] = (fcs >>> 8) & 0xff;

  // Worst case: every byte escaped + 2 flags.
  const out = new Uint8Array(raw.length * 2 + 2);
  let o = 0;
  out[o++] = FLAG;
  for (const b of raw) {
    if (b === FLAG || b === ESCAPE || b < 0x20) {
      out[o++] = ESCAPE;
      out[o++] = b ^ 0x20;
    } else {
      out[o++] = b;
    }
  }
  out[o++] = FLAG;
  return out.subarray(0, o);
}

/** Streaming HDLC decoder: feed serial bytes, receive verified frames via onFrame. */
export class HdlcDecoder {
  badFcs = 0;
  private buf = new Uint8Array(4096);
  private len = 0;
  private esc = false;
  private onFrame: (f: HdlcFrame) => void;

  constructor(onFrame: (f: HdlcFrame) => void) {
    this.onFrame = onFrame;
  }

  feed(chunk: Uint8Array): void {
    for (const b of chunk) {
      if (b === FLAG) {
        if (this.len > 0) this.finish();
        this.esc = false;
        continue;
      }
      if (b === ESCAPE) {
        this.esc = true;
        continue;
      }
      let v = b;
      if (this.esc) {
        v = b ^ 0x20;
        this.esc = false;
      }
      if (this.len < this.buf.length) this.buf[this.len++] = v;
      else this.len = 0; // oversized garbage — drop and resync at next flag
    }
  }

  private finish(): void {
    const raw = this.buf.subarray(0, this.len);
    this.len = 0;
    if (raw.length < 4) return;                      // runt (needs proto + FCS at minimum)
    if (fcs16(raw) !== GOOD_FCS) { this.badFcs++; return; }

    let i = 0;
    if (raw[0] === 0xff && raw[1] === 0x03) i = 2;   // addr/ctrl may be compressed away
    // Protocol field: 2 bytes, or 1 byte when compressed (odd low byte).
    let proto: number;
    if ((raw[i] & 1) === 0) {
      proto = (raw[i] << 8) | raw[i + 1];
      i += 2;
    } else {
      proto = raw[i];
      i += 1;
    }
    this.onFrame({ proto, payload: raw.slice(i, raw.length - 2) });
  }
}
