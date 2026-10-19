// ppplink.test.ts — protocol-level tests for the WiredLink stack. These exercise exactly the
// exchanges lwIP's PPP client performs, so a green run means the browser end will answer a real
// ESP32 correctly (framing, negotiation, addressing, splice) without hardware on the desk.
import { describe, expect, it, vi } from 'vitest';

import { buildCp, buildOptions, parseCp, PROTO_IPCP } from './cp';
import { answerDns, DnsMap, queryName } from './dns';
import { encodeFrame, fcs16, HdlcDecoder } from './hdlc';
import type { HdlcFrame } from './hdlc';
import { Ipcp } from './ipcp';
import { buildIpv4, checksum16, parseIpv4, transportChecksum, IPPROTO_TCP } from './ipv4';
import { Lcp } from './lcp';
import { answerNtp } from './ntp';
import { TcpSplice } from './tcp';

const collect = () => {
  const sent: { proto: number; payload: Uint8Array }[] = [];
  return { sent, send: (proto: number, payload: Uint8Array) => sent.push({ proto, payload }) };
};

describe('hdlc', () => {
  it('matches the CRC-16/X.25 check value', () => {
    expect(fcs16(new TextEncoder().encode('123456789'))).toBe(~0x906e & 0xffff);
  });

  it('round-trips frames incl. bytes needing escapes', () => {
    const payload = new Uint8Array([0x7e, 0x7d, 0x00, 0x1f, 0x41, 0xff]);
    const frames: HdlcFrame[] = [];
    const dec = new HdlcDecoder((f) => frames.push(f));
    const wire = encodeFrame(0xc021, payload);
    // No unescaped flag/escape bytes inside the frame body.
    expect(wire.subarray(1, wire.length - 1).includes(0x7e)).toBe(false);
    // Feed in awkward chunk sizes to prove streaming reassembly.
    dec.feed(wire.subarray(0, 3));
    dec.feed(wire.subarray(3, 4));
    dec.feed(wire.subarray(4));
    expect(frames).toHaveLength(1);
    expect(frames[0].proto).toBe(0xc021);
    expect([...frames[0].payload]).toEqual([...payload]);
  });

  it('drops corrupted frames and counts them', () => {
    const frames: HdlcFrame[] = [];
    const dec = new HdlcDecoder((f) => frames.push(f));
    const wire = encodeFrame(0x0021, new Uint8Array([1, 2, 3]));
    wire[4] ^= 0x55; // corrupt a body byte
    dec.feed(wire);
    expect(frames).toHaveLength(0);
    expect(dec.badFcs).toBe(1);
  });

  it('accepts compressed addr/ctrl + protocol fields', () => {
    // Simulate a peer sending [proto-compressed 0x21][data] without ff 03.
    const raw = new Uint8Array([0x21, 0xaa, 0xbb, 0, 0]);
    const fcs = fcs16(raw.subarray(0, 3)) ^ 0xffff;
    raw[3] = fcs & 0xff;
    raw[4] = (fcs >>> 8) & 0xff;
    const frames: HdlcFrame[] = [];
    const dec = new HdlcDecoder((f) => frames.push(f));
    dec.feed(new Uint8Array([0x7e, ...raw, 0x7e]));
    expect(frames).toHaveLength(1);
    expect(frames[0].proto).toBe(0x0021);
    expect([...frames[0].payload]).toEqual([0xaa, 0xbb]);
  });
});

describe('lcp', () => {
  const devConfReq = (id: number) =>
    parseCp(buildCp(1, id, buildOptions([
      { type: 1, value: new Uint8Array([0x05, 0xdc]) },             // MRU 1500
      { type: 5, value: new Uint8Array([1, 2, 3, 4]) },             // magic
    ])))!;

  it('acks a friendly Conf-Req and opens once ours is acked', () => {
    vi.useFakeTimers();
    const { sent, send } = collect();
    const onOpen = vi.fn();
    const lcp = new Lcp(send, onOpen, vi.fn());
    lcp.start();
    expect(sent[0].payload[0]).toBe(1);              // our Conf-Req went out
    lcp.handle(devConfReq(7));
    const ack = sent.find((p) => p.payload[0] === 2 && p.payload[1] === 7);
    expect(ack).toBeTruthy();
    lcp.handle(parseCp(buildCp(2, sent[0].payload[1], sent[0].payload.slice(4)))!);
    expect(onOpen).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('rejects auth options', () => {
    const { sent, send } = collect();
    const lcp = new Lcp(send, vi.fn(), vi.fn());
    lcp.handle(parseCp(buildCp(1, 9, buildOptions([
      { type: 3, value: new Uint8Array([0xc0, 0x23]) },             // PAP — never
    ])))!);
    const rej = sent.find((p) => p.payload[0] === 4);
    expect(rej).toBeTruthy();
    expect(rej!.payload[4]).toBe(3);
  });

  it('answers Echo-Req with our magic', () => {
    const { sent, send } = collect();
    const lcp = new Lcp(send, vi.fn(), vi.fn());
    lcp.handle(parseCp(buildCp(9, 3, new Uint8Array([9, 9, 9, 9])))!);
    const rep = sent.find((p) => p.payload[0] === 10);
    expect(rep).toBeTruthy();
    expect(rep!.payload[1]).toBe(3);
    expect([...rep!.payload.slice(4, 8)]).not.toEqual([9, 9, 9, 9]); // ours, not theirs
  });
});

describe('ipcp', () => {
  it('naks 0.0.0.0 to the plan address then acks', () => {
    const { sent, send } = collect();
    const onOpen = vi.fn();
    const ipcp = new Ipcp('10.0.0.1', '10.0.0.2', send, onOpen, vi.fn());
    ipcp.start();
    ipcp.handle(parseCp(buildCp(1, 1, buildOptions([
      { type: 3, value: new Uint8Array([0, 0, 0, 0]) },
    ])))!);
    const nak = sent.find((p) => p.proto === PROTO_IPCP && p.payload[0] === 3);
    expect([...nak!.payload.slice(6, 10)]).toEqual([10, 0, 0, 2]);
    ipcp.handle(parseCp(buildCp(1, 2, buildOptions([
      { type: 3, value: new Uint8Array([10, 0, 0, 2]) },
    ])))!);
    expect(sent.some((p) => p.payload[0] === 2 && p.payload[1] === 2)).toBe(true);
    // Device acks our Conf-Req -> open.
    ipcp.handle(parseCp(buildCp(2, sent[0].payload[1], sent[0].payload.slice(4)))!);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('rejects VJ compression', () => {
    const { sent, send } = collect();
    const ipcp = new Ipcp('10.0.0.1', '10.0.0.2', send, vi.fn(), vi.fn());
    ipcp.handle(parseCp(buildCp(1, 5, buildOptions([
      { type: 2, value: new Uint8Array([0x00, 0x2d, 1, 1]) },
    ])))!);
    expect(sent.some((p) => p.payload[0] === 4)).toBe(true);
  });
});

describe('dns/ntp', () => {
  // A minimal query for broker.example A IN.
  const query = new Uint8Array([
    0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
    6, ...new TextEncoder().encode('broker'), 7, ...new TextEncoder().encode('example'), 0,
    0, 1, 0, 1,
  ]);

  it('answers every A query with the broker ip', () => {
    const resp = answerDns(query, new Uint8Array([10, 0, 0, 3]))!;
    expect(resp[2] & 0x80).toBe(0x80);                    // QR
    expect((resp[6] << 8) | resp[7]).toBe(1);             // ANCOUNT
    expect([...resp.slice(-4)]).toEqual([10, 0, 0, 3]);
  });

  it('parses the query name for DnsMap allocation', () => {
    expect(queryName(query)).toBe('broker.example');
    expect(queryName(new Uint8Array(5))).toBeNull();
  });

  it('DnsMap hands each hostname a distinct synthetic IP and resolves it back', () => {
    const map = new DnsMap();
    const a = map.ipFor('db.supabase.co');
    const b = map.ipFor('pool.ntp.org');
    expect([...a]).toEqual([10, 0, 0, 100]);
    expect([...b]).toEqual([10, 0, 0, 101]);
    expect([...map.ipFor('db.supabase.co')]).toEqual([...a]);   // stable per host
    expect(map.lookup(a)).toBe('db.supabase.co');
    expect(map.lookup(b)).toBe('pool.ntp.org');
    expect(map.lookup(new Uint8Array([10, 0, 0, 3]))).toBeNull();  // unallocated
    expect(map.lookup(new Uint8Array([152, 228, 219, 243]))).toBeNull();  // non-synthetic
  });

  it('DnsMap wraps its pool and evicts the reused entry', () => {
    const map = new DnsMap();
    for (let i = 0; i < 100; i++) map.ipFor(`host-${i}.example`);
    const wrapped = map.ipFor('one-more.example');   // pool of 100 exhausted → reuses .100
    expect(wrapped[3]).toBe(100);
    expect(map.lookup(wrapped)).toBe('one-more.example');
    expect([...map.ipFor('host-0.example')]).toEqual([10, 0, 0, 101]); // evicted, re-allocated
  });

  it('answers SNTP with server mode + sane time', () => {
    const q = new Uint8Array(48);
    q[0] = 0x23; // VN=4 client
    const nowMs = 1_752_000_000_000;
    const r = answerNtp(q, nowMs)!;
    expect(r[0] & 0x07).toBe(4);                          // mode server
    const secs = (r[40] * 2 ** 24 + r[41] * 2 ** 16 + r[42] * 2 ** 8 + r[43]) >>> 0;
    expect(secs).toBe(Math.floor(nowMs / 1000) + 2208988800);
  });
});

describe('tcp splice', () => {
  const HOST = new Uint8Array([10, 0, 0, 3]);
  const DEV = new Uint8Array([10, 0, 0, 2]);

  function seg(opts: { src?: number; seq: number; ack?: number; flags: number; payload?: Uint8Array; window?: number }): Uint8Array {
    const payload = opts.payload ?? new Uint8Array(0);
    const s = new Uint8Array(20 + payload.length);
    const src = opts.src ?? 50000;
    s[0] = src >> 8; s[1] = src & 0xff;
    s[2] = 8883 >> 8; s[3] = 8883 & 0xff;
    s[4] = (opts.seq >>> 24) & 0xff; s[5] = (opts.seq >>> 16) & 0xff; s[6] = (opts.seq >>> 8) & 0xff; s[7] = opts.seq & 0xff;
    const ack = opts.ack ?? 0;
    s[8] = (ack >>> 24) & 0xff; s[9] = (ack >>> 16) & 0xff; s[10] = (ack >>> 8) & 0xff; s[11] = ack & 0xff;
    s[12] = 5 << 4;
    s[13] = opts.flags;
    const win = opts.window ?? 0xffff;
    s[14] = (win >>> 8) & 0xff; s[15] = win & 0xff;
    s.set(payload, 20);
    return s;
  }

  function mkSplice() {
    const packets: Uint8Array[] = [];
    const events = { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() };
    const splice = new TcpSplice(HOST, DEV, 8883, (p) => packets.push(p), events);
    const lastTcp = () => parseIpv4(packets[packets.length - 1])!.payload;
    return { splice, packets, events, lastTcp };
  }

  it('handshakes, forwards in-order data, acks, and round-trips bridge bytes', () => {
    const { splice, packets, events, lastTcp } = mkSplice();

    splice.handle(seg({ seq: 1000, flags: 0x02 }));                       // SYN
    let t = lastTcp();
    expect(t[13] & 0x12).toBe(0x12);                                      // SYN|ACK
    const iss = ((t[4] << 24) | (t[5] << 16) | (t[6] << 8) | t[7]) >>> 0;
    const ackNo = ((t[8] << 24) | (t[9] << 16) | (t[10] << 8) | t[11]) >>> 0;
    expect(ackNo).toBe(1001);
    // Outgoing checksum is valid.
    expect(transportChecksum(IPPROTO_TCP, HOST, DEV, t)).toBe(0);

    splice.handle(seg({ seq: 1001, ack: (iss + 1) >>> 0, flags: 0x10 })); // ACK completes
    expect(events.onOpen).toHaveBeenCalledOnce();

    const hello = new TextEncoder().encode('client-hello');
    splice.handle(seg({ seq: 1001, ack: (iss + 1) >>> 0, flags: 0x18, payload: hello }));
    expect(events.onData).toHaveBeenCalledWith(expect.objectContaining({ length: hello.length }));
    t = lastTcp();
    const ackAfter = ((t[8] << 24) | (t[9] << 16) | (t[10] << 8) | t[11]) >>> 0;
    expect(ackAfter).toBe(1001 + hello.length);

    const before = packets.length;
    splice.push(new TextEncoder().encode('server-hello'));                // broker -> device
    expect(packets.length).toBe(before + 1);
    t = lastTcp();
    expect(((t[4] << 24) | (t[5] << 16) | (t[6] << 8) | t[7]) >>> 0).toBe((iss + 1) >>> 0);
    expect(new TextDecoder().decode(t.subarray(20))).toBe('server-hello');
    splice.destroy();
  });

  it('resumes sending on a pure window update (flash-write zero-window deadlock)', () => {
    const { splice, packets, lastTcp } = mkSplice();

    splice.handle(seg({ seq: 1000, flags: 0x02 }));                       // SYN
    let t = lastTcp();
    const iss = ((t[4] << 24) | (t[5] << 16) | (t[6] << 8) | t[7]) >>> 0;
    // Handshake ACK advertises a small window: 2 MSS.
    splice.handle(seg({ seq: 1001, ack: (iss + 1) >>> 0, flags: 0x10, window: 2920 }));

    // Bridge has a large body to deliver; only the window's worth may go out.
    splice.push(new Uint8Array(20000));
    const sentData = () => packets
      .map((p) => parseIpv4(p)!.payload)
      .reduce((n, x) => n + Math.max(0, x.length - ((x[12] >>> 4) * 4)), 0);
    expect(sentData()).toBe(2920);

    // Device consumes it (ack advances) but its buffer is full: window 0. Nothing more sends,
    // and with everything acked there is no unacked segment for the RTO to retry — the exact
    // state the wired-OTA download deadlocked in.
    splice.handle(seg({ seq: 1001, ack: (iss + 1 + 2920) >>> 0, flags: 0x10, window: 0 }));
    expect(sentData()).toBe(2920);

    // Pure window update (same ack, reopened window) MUST resume the transfer.
    splice.handle(seg({ seq: 1001, ack: (iss + 1 + 2920) >>> 0, flags: 0x10, window: 0xffff }));
    expect(sentData()).toBeGreaterThan(2920);
    splice.destroy();
  });

  it('carries a full mTLS-shaped exchange with slow ACKs and RTO retransmits', () => {
    // Reproduces the wired broker dial: CH up, ~1085B server flight down, client-cert flight
    // up — with the device ACKing slowly (serial RTT + mbedtls time) so the RTO fires and
    // retransmits in between. The splice must deliver the flight exactly once to onData
    // consumers... (duplicates are acceptable TCP-wise; the DEVICE dedups by seq — what must
    // hold here is that the device's in-order bytes keep flowing and no RST is emitted).
    vi.useFakeTimers();
    const { splice, packets, events, lastTcp } = mkSplice();

    splice.handle(seg({ seq: 5000, flags: 0x02, window: 5744 }));          // SYN
    let t = lastTcp();
    const iss = ((t[4] << 24) | (t[5] << 16) | (t[6] << 8) | t[7]) >>> 0;
    splice.handle(seg({ seq: 5001, ack: (iss + 1) >>> 0, flags: 0x10, window: 5744 }));

    // Device sends ClientHello (287B) — forwarded to the bridge.
    splice.handle(seg({ seq: 5001, ack: (iss + 1) >>> 0, flags: 0x18, payload: new Uint8Array(287), window: 5744 }));
    expect(events.onData).toHaveBeenCalledTimes(1);

    // Broker answers with the 1085B server flight; the device takes 1.6s to ACK (mbedtls),
    // during which the RTO fires and retransmits. No RST may result.
    splice.push(new Uint8Array(1085));
    vi.advanceTimersByTime(1600);                                          // RTO fires ≥1 time
    const rstBefore = packets.some((p) => (parseIpv4(p)!.payload[13] & 0x04) !== 0);
    expect(rstBefore).toBe(false);

    // Device ACKs the flight (late), then streams its client flight in two records.
    splice.handle(seg({ seq: 5001 + 287, ack: (iss + 1 + 1085) >>> 0, flags: 0x10, window: 5744 }));
    splice.handle(seg({ seq: 5001 + 287, ack: (iss + 1 + 1085) >>> 0, flags: 0x18, payload: new Uint8Array(462), window: 5744 }));
    splice.handle(seg({ seq: 5001 + 287 + 462, ack: (iss + 1 + 1085) >>> 0, flags: 0x18, payload: new Uint8Array(900), window: 5744 }));
    expect(events.onData).toHaveBeenCalledTimes(3);                        // CH + 2 client records
    expect(events.onClose).not.toHaveBeenCalled();

    // And the splice can still deliver more broker bytes afterwards.
    splice.push(new Uint8Array(300));
    const t2 = lastTcp();
    expect(t2.length - ((t2[12] >>> 4) * 4)).toBe(300);
    splice.destroy();
    vi.useRealTimers();
  });

  it('re-acks out-of-order data without forwarding it', () => {
    const { splice, events, lastTcp } = mkSplice();
    splice.handle(seg({ seq: 1000, flags: 0x02 }));
    const t0 = lastTcp();
    const iss = ((t0[4] << 24) | (t0[5] << 16) | (t0[6] << 8) | t0[7]) >>> 0;
    splice.handle(seg({ seq: 1001, ack: (iss + 1) >>> 0, flags: 0x10 }));
    splice.handle(seg({ seq: 5000, ack: (iss + 1) >>> 0, flags: 0x18, payload: new Uint8Array(10) }));
    expect(events.onData).not.toHaveBeenCalled();
    const t = lastTcp();
    expect(((t[8] << 24) | (t[9] << 16) | (t[10] << 8) | t[11]) >>> 0).toBe(1001); // still rcv_nxt
    splice.destroy();
  });
});

describe('peer restart (device reboot)', () => {
  it('re-negotiates LCP when a Conf-Req arrives on an open link', () => {
    vi.useFakeTimers();
    const { sent, send } = collect();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const lcp = new Lcp(send, onOpen, onClose);
    lcp.start();
    lcp.handle(parseCp(buildCp(1, 1, buildOptions([{ type: 5, value: new Uint8Array([1, 2, 3, 4]) }])))!);
    lcp.handle(parseCp(buildCp(2, sent[0].payload[1], sent[0].payload.slice(4)))!);
    expect(onOpen).toHaveBeenCalledOnce();

    // Device reboots and starts over with a fresh Conf-Req.
    const before = sent.length;
    lcp.handle(parseCp(buildCp(1, 1, buildOptions([{ type: 5, value: new Uint8Array([9, 9, 9, 9]) }])))!);
    expect(onClose).toHaveBeenCalledOnce();                       // owner tears down flows/IPCP
    const after = sent.slice(before);
    expect(after.some((p) => p.payload[0] === 1)).toBe(true);     // our Conf-Req re-asserted
    expect(after.some((p) => p.payload[0] === 2)).toBe(true);     // theirs acked
    // Device acks our new Conf-Req -> link re-opens.
    const ourReq = after.find((p) => p.payload[0] === 1)!;
    lcp.handle(parseCp(buildCp(2, ourReq.payload[1], ourReq.payload.slice(4)))!);
    expect(onOpen).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('tcp flow teardown', () => {
  const HOST = new Uint8Array([10, 0, 0, 3]);
  const DEV = new Uint8Array([10, 0, 0, 2]);

  it('fires onClose on graceful FIN completion so the owner can reset', () => {
    const packets: Uint8Array[] = [];
    const events = { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() };
    const splice = new TcpSplice(HOST, DEV, 8883, (p) => packets.push(p), events);
    const seg = (o: { seq: number; ack?: number; flags: number }) => {
      const s = new Uint8Array(20);
      s[0] = 50000 >> 8; s[1] = 50000 & 0xff; s[2] = 8883 >> 8; s[3] = 8883 & 0xff;
      s[4] = (o.seq >>> 24) & 0xff; s[5] = (o.seq >>> 16) & 0xff; s[6] = (o.seq >>> 8) & 0xff; s[7] = o.seq & 0xff;
      const a = o.ack ?? 0;
      s[8] = (a >>> 24) & 0xff; s[9] = (a >>> 16) & 0xff; s[10] = (a >>> 8) & 0xff; s[11] = a & 0xff;
      s[12] = 5 << 4; s[13] = o.flags; s[14] = 0xff; s[15] = 0xff;
      return s;
    };
    splice.handle(seg({ seq: 100, flags: 0x02 }));                      // SYN
    const t = parseIpv4(packets[packets.length - 1])!.payload;
    const iss = ((t[4] << 24) | (t[5] << 16) | (t[6] << 8) | t[7]) >>> 0;
    splice.handle(seg({ seq: 101, ack: (iss + 1) >>> 0, flags: 0x10 })); // ACK
    splice.handle(seg({ seq: 101, ack: (iss + 1) >>> 0, flags: 0x11 })); // FIN|ACK
    // Our FIN goes out; device acks it -> graceful completion must still fire onClose.
    splice.handle(seg({ seq: 102, ack: (iss + 2) >>> 0, flags: 0x10 }));
    expect(events.onClose).toHaveBeenCalled();
    splice.destroy();
  });
});

describe('ipv4', () => {
  it('builds headers with a valid checksum', () => {
    const pkt = parseIpv4(
      buildIpv4(17, new Uint8Array([10, 0, 0, 1]), new Uint8Array([10, 0, 0, 2]), new Uint8Array([1, 2, 3])),
    )!;
    expect(pkt.proto).toBe(17);
    expect([...pkt.dst]).toEqual([10, 0, 0, 2]);
    expect([...pkt.payload]).toEqual([1, 2, 3]);
  });

  it('checksum16 of a checksummed header is zero', () => {
    const raw = buildIpv4(6, new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8]), new Uint8Array(0));
    expect(checksum16(raw.subarray(0, 20))).toBe(0);
  });
});
