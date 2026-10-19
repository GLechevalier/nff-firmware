// ipv4.ts — minimal IPv4 + UDP parse/build for the WiredLink's userspace stack.
//
// Scope is deliberately tiny: no fragmentation (PPP MTU 1500 and our flows are small), no
// options on TX, checksums computed the RFC 1071 way. TCP lives in tcp.ts; this module only
// carries whole IP packets and UDP datagrams.

export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;

export function checksum16(data: Uint8Array, initial = 0): number {
  let sum = initial;
  for (let i = 0; i + 1 < data.length; i += 2) sum += (data[i] << 8) | data[i + 1];
  if (data.length & 1) sum += data[data.length - 1] << 8;
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

export interface Ipv4Packet {
  proto: number;
  src: Uint8Array;   // 4 bytes
  dst: Uint8Array;   // 4 bytes
  payload: Uint8Array;
}

export function parseIpv4(data: Uint8Array): Ipv4Packet | null {
  if (data.length < 20 || data[0] >>> 4 !== 4) return null;
  const ihl = (data[0] & 0x0f) * 4;
  const totalLen = (data[2] << 8) | data[3];
  if (ihl < 20 || totalLen < ihl || totalLen > data.length) return null;
  const fragOffset = ((data[6] & 0x1f) << 8) | data[7];
  const moreFrags = (data[6] & 0x20) !== 0;
  if (fragOffset !== 0 || moreFrags) return null; // fragments unsupported (never seen on this link)
  return {
    proto: data[9],
    src: data.slice(12, 16),
    dst: data.slice(16, 20),
    payload: data.slice(ihl, totalLen),
  };
}

let ipId = 1;

export function buildIpv4(proto: number, src: Uint8Array, dst: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + payload.length);
  out[0] = 0x45;                       // v4, IHL 5
  out[2] = (out.length >>> 8) & 0xff;
  out[3] = out.length & 0xff;
  ipId = (ipId + 1) & 0xffff;
  out[4] = (ipId >>> 8) & 0xff;
  out[5] = ipId & 0xff;
  out[6] = 0x40;                       // DF
  out[8] = 64;                         // TTL
  out[9] = proto;
  out.set(src, 12);
  out.set(dst, 16);
  const ck = checksum16(out.subarray(0, 20));
  out[10] = (ck >>> 8) & 0xff;
  out[11] = ck & 0xff;
  out.set(payload, 20);
  return out;
}

/** RFC 768 pseudo-header checksum shared by UDP and TCP. */
export function transportChecksum(
  proto: number, src: Uint8Array, dst: Uint8Array, segment: Uint8Array,
): number {
  const pseudo = new Uint8Array(12 + segment.length + (segment.length & 1));
  pseudo.set(src, 0);
  pseudo.set(dst, 4);
  pseudo[9] = proto;
  pseudo[10] = (segment.length >>> 8) & 0xff;
  pseudo[11] = segment.length & 0xff;
  pseudo.set(segment, 12);
  return checksum16(pseudo);
}

export interface UdpDatagram {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export function parseUdp(payload: Uint8Array): UdpDatagram | null {
  if (payload.length < 8) return null;
  const len = (payload[4] << 8) | payload[5];
  if (len < 8 || len > payload.length) return null;
  return {
    srcPort: (payload[0] << 8) | payload[1],
    dstPort: (payload[2] << 8) | payload[3],
    payload: payload.slice(8, len),
  };
}

export function buildUdp(
  src: Uint8Array, dst: Uint8Array, srcPort: number, dstPort: number, payload: Uint8Array,
): Uint8Array {
  const seg = new Uint8Array(8 + payload.length);
  seg[0] = (srcPort >>> 8) & 0xff;
  seg[1] = srcPort & 0xff;
  seg[2] = (dstPort >>> 8) & 0xff;
  seg[3] = dstPort & 0xff;
  seg[4] = (seg.length >>> 8) & 0xff;
  seg[5] = seg.length & 0xff;
  seg.set(payload, 8);
  const ck = transportChecksum(IPPROTO_UDP, src, dst, seg);
  seg[6] = (ck >>> 8) & 0xff;
  seg[7] = ck === 0 ? 0xff : ck & 0xff; // 0 means "no checksum" in UDP; transmit as 0xFFFF
  return buildIpv4(IPPROTO_UDP, src, dst, seg);
}
