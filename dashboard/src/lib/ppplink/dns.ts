// dns.ts — the WiredLink's DNS: every A query is answered with a SYNTHETIC IP, and DnsMap
// remembers which hostname each synthetic IP stands for. That mapping is what lets the flow
// router recover the true destination at SYN time: the device resolves e.g.
// ezbtxodxkzizqagbgzuc.supabase.co (an OTA artifact download), gets 10.0.0.100, SYNs
// 10.0.0.100:443 — and the WiredLink looks the IP back up to ask the bridge for
// "that-host:443". UDP stays routed by port (123 → SNTP responder) whatever the dst IP, and
// the broker is dialed by IP literal (credentials.h) so it never passes through here.
// AAAA and other query types get an empty NOERROR so lwIP falls through to A.

/** Allocates one synthetic IP per hostname from 10.0.0.100–199 and resolves them back. */
export class DnsMap {
  private byHost = new Map<string, number>();  // hostname -> last octet
  private byOctet = new Map<number, string>();
  private next = 100;

  /** The synthetic IP for `host`, allocating one on first sight. */
  ipFor(host: string): Uint8Array {
    let octet = this.byHost.get(host);
    if (octet === undefined) {
      octet = this.next;
      this.next = this.next >= 199 ? 100 : this.next + 1; // wrap: ancient entries get evicted
      const evicted = this.byOctet.get(octet);
      if (evicted !== undefined) this.byHost.delete(evicted);
      this.byHost.set(host, octet);
      this.byOctet.set(octet, host);
    }
    return new Uint8Array([10, 0, 0, octet]);
  }

  /** The hostname a synthetic IP was handed out for, or null (incl. non-synthetic IPs). */
  lookup(ip: Uint8Array): string | null {
    if (ip.length !== 4 || ip[0] !== 10 || ip[1] !== 0 || ip[2] !== 0) return null;
    return this.byOctet.get(ip[3]) ?? null;
  }
}

/** Decode the first question's QNAME (lowercased dotted name), for DnsMap allocation. */
export function queryName(query: Uint8Array): string | null {
  if (query.length < 12) return null;
  const labels: string[] = [];
  let i = 12;
  while (i < query.length && query[i] !== 0) {
    if ((query[i] & 0xc0) !== 0) return null;
    const len = query[i];
    if (i + 1 + len > query.length) return null;
    labels.push(String.fromCharCode(...query.subarray(i + 1, i + 1 + len)));
    i += len + 1;
  }
  return labels.length ? labels.join('.').toLowerCase() : null;
}

export function answerDns(query: Uint8Array, answerIp: Uint8Array): Uint8Array | null {
  if (query.length < 12) return null;
  const qdcount = (query[4] << 8) | query[5];
  if (qdcount < 1) return null;

  // Walk QNAME of the first (and in practice only) question.
  let i = 12;
  while (i < query.length && query[i] !== 0) {
    if ((query[i] & 0xc0) !== 0) return null; // compression illegal in a question
    i += query[i] + 1;
  }
  if (i + 5 > query.length) return null;
  const qtype = (query[i + 1] << 8) | query[i + 2];
  const questionEnd = i + 5;

  const isA = qtype === 1;
  const out = new Uint8Array(questionEnd + (isA ? 16 : 0));
  out.set(query.subarray(0, questionEnd));
  out[2] = 0x84; // QR=1 (response), AA=1
  out[3] = 0x00; // RA=0, RCODE=NOERROR
  out[4] = 0x00; out[5] = 0x01;                    // QDCOUNT 1
  out[6] = 0x00; out[7] = isA ? 0x01 : 0x00;       // ANCOUNT
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0;

  if (isA) {
    let o = questionEnd;
    out[o++] = 0xc0; out[o++] = 0x0c;              // name: pointer to the question's QNAME
    out[o++] = 0x00; out[o++] = 0x01;              // TYPE A
    out[o++] = 0x00; out[o++] = 0x01;              // CLASS IN
    out[o++] = 0x00; out[o++] = 0x00; out[o++] = 0x01; out[o++] = 0x2c; // TTL 300
    out[o++] = 0x00; out[o++] = 0x04;              // RDLENGTH 4
    out.set(answerIp, o);
  }
  return out;
}
