import { describe, expect, it } from "vitest";
import {
  decodeFramePacket,
  encodeFramePacket,
  FrameRateGate,
  LatestFrameBroadcaster,
  type FrameSocket,
} from "../src/frame-transport.js";

class FakeSocket implements FrameSocket {
  readyState = 1;
  readonly sent: Uint8Array[] = [];

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
}

function frame(sequence: number): Uint8Array {
  return encodeFramePacket({
    sequence,
    capturedAt: 1_700_000_000_000 + sequence,
    sourceWidth: 1280,
    sourceHeight: 800,
    jpeg: Uint8Array.from([sequence, sequence + 1, sequence + 2]),
  });
}

describe("latest-frame transport", () => {
  it("caps a bursty capture source while preserving the newest time slot", () => {
    const gate = new FrameRateGate(20);
    const published = [0, 10, 30, 49, 50, 70, 99, 100]
      .filter((capturedAt) => gate.shouldPublish(capturedAt));

    expect(published).toEqual([0, 50, 100]);

    gate.setMaxFps(10);
    expect(gate.shouldPublish(150)).toBe(false);
    expect(gate.shouldPublish(200)).toBe(true);
  });

  it("keeps a bounded in-flight window and replaces stale pending frames", () => {
    const socket = new FakeSocket();
    const broadcaster = new LatestFrameBroadcaster({ maxInFlight: 2 });
    broadcaster.add(socket);

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      broadcaster.publish(sequence, frame(sequence));
    }

    expect(socket.sent.map((packet) => decodeFramePacket(packet).sequence)).toEqual([1, 2]);
    expect(broadcaster.stats(socket)).toMatchObject({
      inFlight: 2,
      hasPending: true,
      droppedFrames: 17,
    });

    broadcaster.acknowledge(socket, 1, 1_700_000_000_100);

    expect(socket.sent.map((packet) => decodeFramePacket(packet).sequence)).toEqual([1, 2, 20]);
    expect(broadcaster.stats(socket)).toMatchObject({
      inFlight: 2,
      hasPending: false,
      droppedFrames: 17,
    });
  });

  it("replays the latest frame immediately when a client joins", () => {
    const socket = new FakeSocket();
    const broadcaster = new LatestFrameBroadcaster();

    broadcaster.publish(1, frame(1));
    broadcaster.add(socket);

    expect(socket.sent.map((packet) => decodeFramePacket(packet).sequence)).toEqual([1]);
  });

  it("encodes JPEG bytes and coordinate metadata in one binary packet", () => {
    const packet = frame(7);
    const decoded = decodeFramePacket(packet);

    expect(decoded).toMatchObject({
      sequence: 7,
      capturedAt: 1_700_000_000_007,
      sourceWidth: 1280,
      sourceHeight: 800,
    });
    expect([...decoded.jpeg]).toEqual([7, 8, 9]);
    expect(packet.byteLength).toBe(decoded.jpeg.byteLength + 32);
  });

  it("can pause JPEG delivery while a client uses WebRTC", () => {
    const socket = new FakeSocket();
    const broadcaster = new LatestFrameBroadcaster();
    broadcaster.add(socket);
    broadcaster.setEnabled(socket, false);
    broadcaster.publish(1, frame(1));
    expect(socket.sent).toHaveLength(0);
    broadcaster.setEnabled(socket, true);
    expect(socket.sent.map((packet) => decodeFramePacket(packet).sequence)).toEqual([1]);
  });
});
