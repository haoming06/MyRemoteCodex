import { describe, expect, it } from "vitest";
import { VideoActivationGate } from "../src/video/webrtc.js";

describe("WebRTC video activation", () => {
  it("does not disable JPEG until transport, native video, and the browser are ready", () => {
    const connectionFirst = new VideoActivationGate();
    expect(connectionFirst.markConnected()).toBe(false);
    expect(connectionFirst.markFrameSeen()).toBe(false);
    expect(connectionFirst.markClientReady()).toBe(true);
    expect(connectionFirst.markClientReady()).toBe(false);

    const clientFirst = new VideoActivationGate();
    expect(clientFirst.markClientReady()).toBe(false);
    expect(clientFirst.markFrameSeen()).toBe(false);
    expect(clientFirst.markConnected()).toBe(true);
    expect(clientFirst.markConnected()).toBe(false);
  });
});
