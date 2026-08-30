import type { ClientMessage } from "./protocol.js";

interface PendingInput<Client> {
  client: Client;
  message: ClientMessage;
}

type ExecuteInput<Client> = (client: Client, message: ClientMessage) => Promise<void>;
type HandleInputError<Client> = (client: Client, error: unknown) => void;

function clamp(value: number): number {
  return Math.min(2_000, Math.max(-2_000, value));
}

function mergeMessages(previous: ClientMessage, next: ClientMessage): ClientMessage | undefined {
  if (previous.type === "input/pointer" && previous.event === "move"
    && next.type === "input/pointer" && next.event === "move") {
    return next;
  }
  if (previous.type === "input/wheel" && next.type === "input/wheel") {
    return {
      ...next,
      deltaX: clamp(previous.deltaX + next.deltaX),
      deltaY: clamp(previous.deltaY + next.deltaY),
    };
  }
  return undefined;
}

export class RemoteInputScheduler<Client> {
  private readonly pending: Array<PendingInput<Client>> = [];
  private running = false;

  constructor(
    private readonly execute: ExecuteInput<Client>,
    private readonly handleError: HandleInputError<Client> = () => {},
  ) {}

  enqueue(client: Client, message: ClientMessage): void {
    const last = this.pending.at(-1);
    if (last?.client === client) {
      const merged = mergeMessages(last.message, message);
      if (merged) last.message = merged;
      else this.pending.push({ client, message });
    } else {
      this.pending.push({ client, message });
    }
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending.length) {
      const input = this.pending.shift()!;
      try {
        await this.execute(input.client, input.message);
      } catch (error) {
        this.handleError(input.client, error);
      }
    }
    this.running = false;
  }
}
