import { describe, expect, it } from "vitest";
import { encodeH264Frame, H264FrameStreamParser } from "../src/video/frame-stream.js";

describe("native H.264 frame stream", () => {
  it("parses arbitrarily split and coalesced helper output", () => {
    const first = encodeH264Frame({
      keyframe: true,
      width: 1600,
      height: 1000,
      timestamp90k: 90_000,
      data: Buffer.from([0, 0, 0, 1, 0x67, 1, 2]),
    });
    const second = encodeH264Frame({
      keyframe: false,
      width: 1600,
      height: 1000,
      timestamp90k: 93_000,
      data: Buffer.from([0, 0, 0, 1, 0x41, 3, 4]),
    });
    const bytes = Buffer.concat([first, second]);
    const parser = new H264FrameStreamParser();
    expect(parser.push(bytes.subarray(0, 9))).toEqual([]);
    const frames = parser.push(bytes.subarray(9));
    expect(frames.map(({ keyframe, timestamp90k }) => ({ keyframe, timestamp90k }))).toEqual([
      { keyframe: true, timestamp90k: 90_000 },
      { keyframe: false, timestamp90k: 93_000 },
    ]);
    expect([...frames[1]!.data]).toEqual([0, 0, 0, 1, 0x41, 3, 4]);
  });

  it("rejects corrupt framing before allocating a payload", () => {
    const packet = encodeH264Frame({
      keyframe: false,
      width: 1,
      height: 1,
      timestamp90k: 0,
      data: Buffer.from([1]),
    });
    packet.writeUInt32BE(0, 0);
    expect(() => new H264FrameStreamParser().push(packet)).toThrow("magic is invalid");
  });
});
