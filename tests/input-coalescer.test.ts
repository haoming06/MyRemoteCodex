import { describe, expect, it } from "vitest";
import { AnimationFrameCoalescer, mergeWheelInputs } from "../client/input-coalescer";

describe("animation-frame input coalescing", () => {
  it("sends only the latest pointer position in one render interval", () => {
    const callbacks: Array<() => void> = [];
    const sent: Array<{ x: number; y: number }> = [];
    const coalescer = new AnimationFrameCoalescer<{ x: number; y: number }>(
      (value) => sent.push(value),
      (_previous, next) => next,
      (callback) => callbacks.push(callback),
    );

    for (let index = 0; index < 100; index += 1) {
      coalescer.enqueue({ x: index, y: index * 2 });
    }

    expect(callbacks).toHaveLength(1);
    expect(sent).toEqual([]);
    callbacks[0]?.();
    expect(sent).toEqual([{ x: 99, y: 198 }]);
  });

  it("accumulates wheel distance while keeping the latest coordinates", () => {
    const callbacks: Array<() => void> = [];
    const sent: Array<{ x: number; y: number; deltaX: number; deltaY: number }> = [];
    const coalescer = new AnimationFrameCoalescer(
      (value) => sent.push(value),
      mergeWheelInputs,
      (callback) => callbacks.push(callback),
    );

    coalescer.enqueue({ x: 10, y: 20, deltaX: 1, deltaY: 2 });
    coalescer.enqueue({ x: 30, y: 40, deltaX: 3, deltaY: 4 });
    coalescer.flush();

    expect(sent).toEqual([{ x: 30, y: 40, deltaX: 4, deltaY: 6 }]);
    callbacks[0]?.();
    expect(sent).toHaveLength(1);

    expect(mergeWheelInputs(
      { x: 0, y: 0, deltaX: 1_900, deltaY: -1_900 },
      { x: 1, y: 1, deltaX: 300, deltaY: -300 },
    )).toEqual({ x: 1, y: 1, deltaX: 2_000, deltaY: -2_000 });
  });
});
