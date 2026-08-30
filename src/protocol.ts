export type ClientMessage =
  | { type: "control/request" }
  | { type: "frame/ack"; sequence: number }
  | { type: "webrtc/offer"; sdp: string }
  | { type: "video/ready" }
  | { type: "stream/quality"; profile: "normal" | "high" }
  | {
      type: "input/pointer";
      event: "move" | "down" | "up";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      buttons?: number;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "input/wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "input/key";
      event: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
      repeat?: boolean;
      location?: number;
    }
  | { type: "input/text"; text: string }
  | { type: "input/submit"; id: string; text: string; takeControl?: boolean }
  | { type: "input/command"; command: "enter" | "backspace" | "escape" | "tab" };

export function parseClientMessage(raw: string): ClientMessage | undefined {
  if (raw.length > 131_072) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    return undefined;
  }
  return value as ClientMessage;
}

export function finiteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function validModifiers(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 15);
}
