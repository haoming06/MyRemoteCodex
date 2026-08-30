import { describe, expect, it } from "vitest";
import { clampZoom, fitScale, pointToSource } from "../client/geometry";

describe("mobile viewport geometry", () => {
  it("maps a scaled canvas point back to renderer coordinates", () => {
    expect(pointToSource(
      210,
      120,
      { left: 10, top: 20, width: 400, height: 200 },
      { width: 1200, height: 600 },
    )).toEqual({ x: 600, y: 300 });
  });

  it("clamps points that fall outside the rendered image", () => {
    expect(pointToSource(-20, 500, { left: 0, top: 0, width: 300, height: 200 }, { width: 900, height: 600 }))
      .toEqual({ x: 0, y: 600 });
  });

  it("fits a desktop renderer inside a phone stage", () => {
    expect(fitScale({ width: 390, height: 700 }, { width: 1440, height: 900 })).toBeCloseTo(390 / 1440);
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.1)).toBe(0.5);
  });
});
