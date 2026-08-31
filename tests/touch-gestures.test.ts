import { describe, expect, it } from "vitest";
import {
  shouldCaptureKeyboardForTouch,
  singleTouchAction,
  updatePinchGesture,
} from "../client/touch-gestures";

describe("mobile touch gestures", () => {
  it("keeps one-finger remote scrolling available after zooming in browse mode", () => {
    expect(singleTouchAction("browse")).toBe("scroll");
  });

  it("keeps direct mode mapped to remote pointer input", () => {
    expect(singleTouchAction("direct")).toBe("pointer");
  });

  it("uses two-finger movement to pan while preserving pinch zoom", () => {
    const update = updatePinchGesture(
      { distance: 100, zoom: 2, centerX: 120, centerY: 240 },
      125,
      132,
      218,
    );

    expect(update.zoom).toBe(2.5);
    expect({ x: update.panX, y: update.panY }).toEqual({ x: 12, y: -22 });
    expect(update.state).toEqual({ distance: 100, zoom: 2, centerX: 132, centerY: 218 });
  });

  it("captures the mobile keyboard only for a light tap inside a remote editable region", () => {
    const regions = [{ left: 280, top: 690, width: 720, height: 84 }];

    expect(shouldCaptureKeyboardForTouch({ x: 640, y: 732 }, regions, 3)).toBe(true);
    expect(shouldCaptureKeyboardForTouch({ x: 80, y: 120 }, regions, 3)).toBe(false);
    expect(shouldCaptureKeyboardForTouch({ x: 640, y: 732 }, regions, 14)).toBe(false);
  });
});
