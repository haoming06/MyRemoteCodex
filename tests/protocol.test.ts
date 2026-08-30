import { describe, expect, it } from "vitest";
import { finiteNumber, parseClientMessage, validModifiers } from "../src/protocol.js";

describe("client protocol guards", () => {
  it("parses a bounded JSON message", () => {
    expect(parseClientMessage('{"type":"control/request"}')).toEqual({ type: "control/request" });
    expect(parseClientMessage(JSON.stringify({
      type: "input/submit",
      id: "message-1",
      text: "执行中补充中文指令",
      takeControl: true,
    }))).toEqual({
      type: "input/submit",
      id: "message-1",
      text: "执行中补充中文指令",
      takeControl: true,
    });
    expect(parseClientMessage('{"type":"frame/ack","sequence":42}')).toEqual({
      type: "frame/ack",
      sequence: 42,
    });
    expect(parseClientMessage('{"type":"webrtc/offer","sdp":"v=0\\r\\n"}')).toEqual({
      type: "webrtc/offer",
      sdp: "v=0\r\n",
    });
    expect(parseClientMessage('{"type":"video/ready"}')).toEqual({ type: "video/ready" });
  });

  it("rejects malformed and oversized messages", () => {
    expect(parseClientMessage("not-json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ value: "x" }))).toBeUndefined();
    expect(parseClientMessage("x".repeat(131_073))).toBeUndefined();
  });

  it("accepts only finite bounded coordinates and CDP modifier bits", () => {
    expect(finiteNumber(10, 0, 20)).toBe(true);
    expect(finiteNumber(Number.NaN, 0, 20)).toBe(false);
    expect(finiteNumber(21, 0, 20)).toBe(false);
    expect(validModifiers(15)).toBe(true);
    expect(validModifiers(16)).toBe(false);
    expect(validModifiers(1.5)).toBe(false);
  });
});
