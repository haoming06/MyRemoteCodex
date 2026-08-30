import { describe, expect, it } from "vitest";
import { H264RtpPacketizer } from "../src/video/h264-packetizer.js";

describe("H.264 RTP packetizer", () => {
  it("keeps SPS/PPS and marks only the final packet of an access unit", () => {
    const packets = new H264RtpPacketizer(96, 1200).packetize({
      keyframe: true,
      width: 1280,
      height: 800,
      timestamp90k: 42,
      data: Buffer.from([
        0, 0, 0, 1, 0x67, 0x64,
        0, 0, 0, 1, 0x68, 0xee,
        0, 0, 0, 1, 0x65, 0x01,
      ]),
    });
    expect(packets).toHaveLength(3);
    expect(packets.map((packet) => packet.payload[0] & 0x1f)).toEqual([7, 8, 5]);
    expect(packets.map((packet) => packet.header.marker)).toEqual([false, false, true]);
    expect(packets.every((packet) => packet.header.timestamp === 42)).toBe(true);
  });

  it("uses FU-A for NAL units larger than the path-safe RTP payload", () => {
    const packets = new H264RtpPacketizer(96, 8).packetize({
      keyframe: false,
      width: 100,
      height: 100,
      timestamp90k: 9,
      data: Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), Buffer.alloc(15, 7)]),
    });
    expect(packets.length).toBeGreaterThan(1);
    expect(packets[0]!.payload[0] & 0x1f).toBe(28);
    expect(packets[0]!.payload[1] & 0x80).toBe(0x80);
    expect(packets.at(-1)!.payload[1] & 0x40).toBe(0x40);
    expect(packets.at(-1)!.header.marker).toBe(true);
  });
});
