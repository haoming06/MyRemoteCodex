const FRAME_MAGIC = 0x4d524346;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 32;
const SOCKET_OPEN = 1;

export interface FramePacket {
  sequence: number;
  capturedAt: number;
  sourceWidth: number;
  sourceHeight: number;
  jpeg: Uint8Array;
}

export interface FrameSocket {
  readonly readyState: number;
  send(data: Uint8Array, options?: { binary?: boolean }): void;
}

export interface FrameTransportStats {
  inFlight: number;
  hasPending: boolean;
  sentFrames: number;
  droppedFrames: number;
  bytesSent: number;
  roundTripMs?: number;
}

export class FrameRateGate {
  private minimumIntervalMs: number;
  private lastPublishedAt?: number;

  constructor(maxFps: number) {
    this.minimumIntervalMs = this.intervalFor(maxFps);
  }

  setMaxFps(maxFps: number): void {
    this.minimumIntervalMs = this.intervalFor(maxFps);
  }

  shouldPublish(capturedAt: number): boolean {
    if (!Number.isFinite(capturedAt)) return false;
    if (
      this.lastPublishedAt === undefined
      || capturedAt < this.lastPublishedAt
      || capturedAt - this.lastPublishedAt >= this.minimumIntervalMs
    ) {
      this.lastPublishedAt = capturedAt;
      return true;
    }
    return false;
  }

  reset(): void {
    this.lastPublishedAt = undefined;
  }

  private intervalFor(maxFps: number): number {
    if (!Number.isFinite(maxFps) || maxFps < 1 || maxFps > 60) {
      throw new RangeError("maxFps must be between 1 and 60");
    }
    return 1_000 / maxFps;
  }
}

interface QueuedFrame {
  sequence: number;
  packet: Uint8Array;
}

interface ClientState {
  enabled: boolean;
  inFlight: Map<number, number>;
  pending?: QueuedFrame;
  sentFrames: number;
  droppedFrames: number;
  bytesSent: number;
  roundTripMs?: number;
}

function uint32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

export function encodeFramePacket(frame: FramePacket): Uint8Array {
  const sequence = uint32(frame.sequence, "sequence");
  const sourceWidth = uint32(frame.sourceWidth, "sourceWidth");
  const sourceHeight = uint32(frame.sourceHeight, "sourceHeight");
  uint32(frame.jpeg.byteLength, "jpeg.byteLength");
  if (!Number.isFinite(frame.capturedAt) || frame.capturedAt < 0) {
    throw new RangeError("capturedAt must be a non-negative timestamp");
  }

  const packet = new Uint8Array(FRAME_HEADER_BYTES + frame.jpeg.byteLength);
  const header = new DataView(packet.buffer);
  header.setUint32(0, FRAME_MAGIC);
  header.setUint8(4, FRAME_VERSION);
  header.setUint8(5, 0);
  header.setUint16(6, FRAME_HEADER_BYTES);
  header.setUint32(8, sequence);
  header.setFloat64(12, frame.capturedAt);
  header.setUint32(20, sourceWidth);
  header.setUint32(24, sourceHeight);
  header.setUint32(28, frame.jpeg.byteLength);
  packet.set(frame.jpeg, FRAME_HEADER_BYTES);
  return packet;
}

export function decodeFramePacket(packet: Uint8Array): FramePacket {
  if (packet.byteLength < FRAME_HEADER_BYTES) throw new Error("Frame packet is truncated");
  const header = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (header.getUint32(0) !== FRAME_MAGIC) throw new Error("Frame packet magic is invalid");
  if (header.getUint8(4) !== FRAME_VERSION) throw new Error("Frame packet version is unsupported");
  const headerBytes = header.getUint16(6);
  const jpegBytes = header.getUint32(28);
  if (headerBytes !== FRAME_HEADER_BYTES || headerBytes + jpegBytes !== packet.byteLength) {
    throw new Error("Frame packet length is invalid");
  }
  return {
    sequence: header.getUint32(8),
    capturedAt: header.getFloat64(12),
    sourceWidth: header.getUint32(20),
    sourceHeight: header.getUint32(24),
    jpeg: packet.subarray(headerBytes),
  };
}

export class LatestFrameBroadcaster {
  private readonly clients = new Map<FrameSocket, ClientState>();
  private readonly maxInFlight: number;
  private latest?: QueuedFrame;

  constructor(options: { maxInFlight?: number } = {}) {
    this.maxInFlight = options.maxInFlight ?? 2;
    if (!Number.isInteger(this.maxInFlight) || this.maxInFlight < 1 || this.maxInFlight > 8) {
      throw new RangeError("maxInFlight must be an integer between 1 and 8");
    }
  }

  add(socket: FrameSocket): void {
    const state: ClientState = {
      enabled: true,
      inFlight: new Map(),
      sentFrames: 0,
      droppedFrames: 0,
      bytesSent: 0,
    };
    this.clients.set(socket, state);
    if (this.latest && socket.readyState === SOCKET_OPEN) this.send(socket, state, this.latest);
  }

  remove(socket: FrameSocket): void {
    this.clients.delete(socket);
  }

  setEnabled(socket: FrameSocket, enabled: boolean): void {
    const state = this.clients.get(socket);
    if (!state) return;
    const wasEnabled = state.enabled;
    state.enabled = enabled;
    if (!enabled) {
      state.inFlight.clear();
      state.pending = undefined;
    } else if (!wasEnabled && this.latest && socket.readyState === SOCKET_OPEN) {
      this.send(socket, state, this.latest);
    }
  }

  publish(sequence: number, packet: Uint8Array): void {
    const queued = { sequence: uint32(sequence, "sequence"), packet };
    this.latest = queued;
    for (const [socket, state] of this.clients) {
      if (!state.enabled) continue;
      if (socket.readyState !== SOCKET_OPEN) continue;
      if (state.inFlight.size < this.maxInFlight) {
        this.send(socket, state, queued);
        continue;
      }
      if (state.pending) state.droppedFrames += 1;
      state.pending = queued;
    }
  }

  acknowledge(socket: FrameSocket, sequence: number, now = Date.now()): void {
    const state = this.clients.get(socket);
    if (!state || !Number.isInteger(sequence)) return;
    const sentAt = state.inFlight.get(sequence);
    if (sentAt === undefined) return;
    state.inFlight.delete(sequence);
    const sample = Math.max(0, now - sentAt);
    state.roundTripMs = state.roundTripMs === undefined
      ? sample
      : state.roundTripMs * 0.8 + sample * 0.2;
    if (state.pending && socket.readyState === SOCKET_OPEN) {
      const pending = state.pending;
      state.pending = undefined;
      this.send(socket, state, pending);
    }
  }

  stats(socket: FrameSocket): FrameTransportStats | undefined {
    const state = this.clients.get(socket);
    if (!state) return undefined;
    return {
      inFlight: state.inFlight.size,
      hasPending: Boolean(state.pending),
      sentFrames: state.sentFrames,
      droppedFrames: state.droppedFrames,
      bytesSent: state.bytesSent,
      roundTripMs: state.roundTripMs,
    };
  }

  private send(socket: FrameSocket, state: ClientState, frame: QueuedFrame): void {
    try {
      socket.send(frame.packet, { binary: true });
      state.inFlight.set(frame.sequence, Date.now());
      state.sentFrames += 1;
      state.bytesSent += frame.packet.byteLength;
    } catch {
      this.clients.delete(socket);
    }
  }
}
