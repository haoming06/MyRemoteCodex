import { describe, expect, it } from "vitest";
import { cdpKeyEvent, virtualKeyCode } from "../src/cdp/keyboard.js";

describe("CDP keyboard events", () => {
  it.each([
    ["Backspace", "Backspace", 8],
    ["Delete", "Delete", 46],
    ["ArrowLeft", "ArrowLeft", 37],
    ["ArrowUp", "ArrowUp", 38],
    ["ArrowRight", "ArrowRight", 39],
    ["ArrowDown", "ArrowDown", 40],
    ["Home", "Home", 36],
    ["End", "End", 35],
    ["Enter", "Enter", 13],
    ["Tab", "Tab", 9],
    ["Escape", "Escape", 27],
    ["KeyA", "a", 65],
    ["Digit7", "7", 55],
    ["F12", "F12", 123],
    ["Numpad4", "4", 100],
  ])("maps %s (%s) to virtual key code %i", (code, key, expected) => {
    expect(virtualKeyCode(code, key)).toBe(expected);
  });

  it("normalizes non-text keydown events for Chromium editing", () => {
    expect(cdpKeyEvent({
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      repeat: true,
    })).toMatchObject({
      type: "rawKeyDown",
      windowsVirtualKeyCode: 8,
      autoRepeat: true,
      isKeypad: false,
    });
  });

  it("preserves text and modifier information for printable shortcuts", () => {
    expect(cdpKeyEvent({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 8,
    })).toMatchObject({
      type: "keyDown",
      text: "a",
      unmodifiedText: "a",
      modifiers: 8,
      windowsVirtualKeyCode: 65,
    });
    expect(cdpKeyEvent({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
    })).toMatchObject({
      type: "rawKeyDown",
      text: "",
      modifiers: 4,
      windowsVirtualKeyCode: 65,
    });
  });

  it("marks numpad events and keeps keyup events as keyup", () => {
    expect(cdpKeyEvent({
      type: "keyUp",
      key: "4",
      code: "Numpad4",
      location: 3,
    })).toMatchObject({
      type: "keyUp",
      windowsVirtualKeyCode: 100,
      isKeypad: true,
    });
  });
});
