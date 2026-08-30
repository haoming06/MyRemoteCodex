const VIDEO_MAGIC = 0x4d524356;
const VIDEO_VERSION = 1;
const VIDEO_HEADER_BYTES = 24;
const MAX_VIDEO_FRAME_BYTES = 16 * 1024 * 1024;

export interface H264Frame {
  keyframe: boolean;
  width: number;
  height: number;
  timestamp90k: number;
  data: Buffer;
}

export function encodeH264Frame(frame: H264Frame): Buffer {
  if (frame.data.byteLength > MAX_VIDEO_FRAME_BYTES) throw new Error("H.264 frame is too large");
  const packet = Buffer.allocUnsafe(VIDEO_HEADER_BYTES + frame.data.byteLength);
  packet.writeUInt32BE(VIDEO_MAGIC, 0);
  packet.writeUInt8(VIDEO_VERSION, 4);
  packet.writeUInt8(frame.keyframe ? 1 : 0, 5);
  packet.writeUInt16BE(VIDEO_HEADER_BYTES, 6);
  packet.writeUInt32BE(frame.width >>> 0, 8);
  packet.writeUInt32BE(frame.height >>> 0, 12);
  packet.writeUInt32BE(frame.timestamp90k >>> 0, 16);
  packet.writeUInt32BE(frame.data.byteLength, 20);
  frame.data.copy(packet, VIDEO_HEADER_BYTES);
  return packet;
}

export class H264FrameStreamParser {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): H264Frame[] {
    this.buffered = this.buffered.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: H264Frame[] = [];

    while (this.buffered.byteLength >= VIDEO_HEADER_BYTES) {
      if (this.buffered.readUInt32BE(0) !== VIDEO_MAGIC) {
        throw new Error("Native video stream magic is invalid");
      }
      if (this.buffered.readUInt8(4) !== VIDEO_VERSION) {
        throw new Error("Native video stream version is unsupported");
      }
      const headerBytes = this.buffered.readUInt16BE(6);
      const payloadBytes = this.buffered.readUInt32BE(20);
      if (headerBytes !== VIDEO_HEADER_BYTES || payloadBytes > MAX_VIDEO_FRAME_BYTES) {
        throw new Error("Native video stream header is invalid");
      }
      const packetBytes = headerBytes + payloadBytes;
      if (this.buffered.byteLength < packetBytes) break;
      frames.push({
        keyframe: (this.buffered.readUInt8(5) & 1) === 1,
        width: this.buffered.readUInt32BE(8),
        height: this.buffered.readUInt32BE(12),
        timestamp90k: this.buffered.readUInt32BE(16),
        data: Buffer.from(this.buffered.subarray(headerBytes, packetBytes)),
      });
      this.buffered = this.buffered.subarray(packetBytes);
    }
    return frames;
  }
}
