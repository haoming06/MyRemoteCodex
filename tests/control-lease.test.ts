import { describe, expect, it } from "vitest";
import { ControlLease } from "../src/control-lease.js";

describe("ControlLease", () => {
  it("allows an explicit user action to take control from another device", () => {
    const first = { open: true };
    const second = { open: true };
    const lease = new ControlLease<typeof first>({
      isOpen: (client) => client.open,
      now: () => 1_000,
    });

    expect(lease.request(first)).toBe(true);
    expect(lease.request(second)).toBe(false);
    expect(lease.stateFor(second)).toEqual({ granted: false, occupied: true });

    lease.takeover(second);

    expect(lease.stateFor(first)).toEqual({ granted: false, occupied: true });
    expect(lease.stateFor(second)).toEqual({ granted: true, occupied: false });
  });
});
