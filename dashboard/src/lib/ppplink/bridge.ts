// bridge.ts — WebSocket client to the fleet's WS↔TCP splice endpoint (nff-fleet /link).
// One instance per device TCP flow; bytes are opaque (the device's TLS session to the broker).
// Device→broker bytes sent before the socket opens are queued, not dropped: the device's TLS
// ClientHello races the WS handshake.

export interface BridgeEvents {
  onData: (data: Uint8Array) => void;
  onClose: () => void;
}

export class BrokerBridge {
  private ws: WebSocket;
  private events: BridgeEvents;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private open = false;
  private closed = false;

  constructor(url: string, events: BridgeEvents) {
    this.events = events;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.open = true;
      for (const chunk of this.queue) this.ws.send(chunk);
      this.queue = [];
    };
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this.events.onData(new Uint8Array(ev.data));
    };
    this.ws.onclose = () => this.emitClose();
    this.ws.onerror = () => this.emitClose();
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    const chunk = new Uint8Array(data); // fresh ArrayBuffer-backed copy (WS rejects ArrayBufferLike views)
    if (this.open) this.ws.send(chunk);
    else this.queue.push(chunk);
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClose();
  }
}
