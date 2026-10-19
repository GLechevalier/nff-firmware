// ntp.ts — SNTP responder from the browser clock. The device MUST get wall time before its mTLS
// handshake (certificate validity), so this answers immediately, stratum 2, no upstream sync —
// the PC clock is exactly as good as the "no internet needed" wired demo requires.

const NTP_UNIX_EPOCH_DELTA = 2208988800; // seconds between 1900-01-01 and 1970-01-01

function writeNtpTimestamp(out: Uint8Array, offset: number, unixMs: number): void {
  const secs = Math.floor(unixMs / 1000) + NTP_UNIX_EPOCH_DELTA;
  const frac = Math.round(((unixMs % 1000) / 1000) * 0x100000000);
  out[offset] = (secs >>> 24) & 0xff;
  out[offset + 1] = (secs >>> 16) & 0xff;
  out[offset + 2] = (secs >>> 8) & 0xff;
  out[offset + 3] = secs & 0xff;
  out[offset + 4] = (frac >>> 24) & 0xff;
  out[offset + 5] = (frac >>> 16) & 0xff;
  out[offset + 6] = (frac >>> 8) & 0xff;
  out[offset + 7] = frac & 0xff;
}

export function answerNtp(query: Uint8Array, nowMs = Date.now()): Uint8Array | null {
  if (query.length < 48) return null;
  const out = new Uint8Array(48);
  out[0] = 0x24;              // LI=0, VN=4, Mode=4 (server)
  out[1] = 2;                 // stratum 2
  out[2] = query[2];          // poll: echo client's
  out[3] = 0xec;              // precision ~1us, conventional
  // root delay/dispersion left 0; reference id "NFF "
  out[12] = 0x4e; out[13] = 0x46; out[14] = 0x46; out[15] = 0x20;
  writeNtpTimestamp(out, 16, nowMs);          // reference
  out.set(query.subarray(40, 48), 24);        // originate = client transmit
  writeNtpTimestamp(out, 32, nowMs);          // receive
  writeNtpTimestamp(out, 40, nowMs);          // transmit
  return out;
}
