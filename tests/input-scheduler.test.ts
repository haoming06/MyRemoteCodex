import { describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "../src/protocol.js";
import { RemoteInputScheduler } from "../src/input-scheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("remote input scheduler", () => {
  it("coalesces wheel input while CDP is busy", async () => {
    const first = deferred();
    const executed: ClientMessage[] = [];
    const scheduler = new RemoteInputScheduler<object>(async (_client, message) => {
      executed.push(message);
      if (executed.length === 1) await first.promise;
    });
    const client = {};

    scheduler.enqueue(client, { type: "input/wheel", x: 10, y: 20, deltaX: 0, deltaY: 1 });
    for (let index = 0; index < 100; index += 1) {
      scheduler.enqueue(client, {
        type: "input/wheel",
        x: index,
        y: index * 2,
        deltaX: 0,
        deltaY: 2,
      });
    }

    expect(executed).toHaveLength(1);
    first.resolve();
    await vi.waitFor(() => expect(executed).toHaveLength(2));
    expect(executed[1]).toEqual({
      type: "input/wheel",
      x: 99,
      y: 198,
      deltaX: 0,
      deltaY: 200,
    });
  });

  it("keeps the latest pointer move without reordering discrete input", async () => {
    const first = deferred();
    const executed: ClientMessage[] = [];
    const scheduler = new RemoteInputScheduler<object>(async (_client, message) => {
      executed.push(message);
      if (executed.length === 1) await first.promise;
    });
    const client = {};

    scheduler.enqueue(client, { type: "input/pointer", event: "down", x: 1, y: 1 });
    scheduler.enqueue(client, { type: "input/pointer", event: "move", x: 2, y: 2 });
    scheduler.enqueue(client, { type: "input/pointer", event: "move", x: 80, y: 90 });
    scheduler.enqueue(client, { type: "input/pointer", event: "up", x: 80, y: 90 });

    first.resolve();
    await vi.waitFor(() => expect(executed).toHaveLength(3));
    expect(executed).toEqual([
      { type: "input/pointer", event: "down", x: 1, y: 1 },
      { type: "input/pointer", event: "move", x: 80, y: 90 },
      { type: "input/pointer", event: "up", x: 80, y: 90 },
    ]);
  });

  it("reports an input failure and continues draining", async () => {
    const errors: unknown[] = [];
    const executed: ClientMessage[] = [];
    const scheduler = new RemoteInputScheduler<object>(async (_client, message) => {
      executed.push(message);
      if (message.type === "input/command") throw new Error("CDP failed");
    }, (_client, error) => errors.push(error));
    const client = {};

    scheduler.enqueue(client, { type: "input/command", command: "escape" });
    scheduler.enqueue(client, { type: "input/text", text: "still runs" });

    await vi.waitFor(() => expect(executed).toHaveLength(2));
    expect(errors).toHaveLength(1);
  });
});
