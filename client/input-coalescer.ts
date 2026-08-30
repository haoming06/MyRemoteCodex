type Scheduler = (callback: () => void) => unknown;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function mergeWheelInputs<T extends { deltaX: number; deltaY: number }>(previous: T, next: T): T {
  return {
    ...next,
    deltaX: clamp(previous.deltaX + next.deltaX, -2_000, 2_000),
    deltaY: clamp(previous.deltaY + next.deltaY, -2_000, 2_000),
  };
}

export class AnimationFrameCoalescer<T> {
  private pending?: T;
  private scheduled = false;
  private generation = 0;

  constructor(
    private readonly emit: (value: T) => void,
    private readonly merge: (previous: T, next: T) => T,
    private readonly schedule: Scheduler = (callback) => requestAnimationFrame(callback),
  ) {}

  enqueue(value: T): void {
    this.pending = this.pending === undefined ? value : this.merge(this.pending, value);
    if (this.scheduled) return;
    this.scheduled = true;
    const generation = ++this.generation;
    this.schedule(() => {
      if (!this.scheduled || generation !== this.generation) return;
      this.flush();
    });
  }

  flush(): void {
    const value = this.pending;
    this.pending = undefined;
    this.scheduled = false;
    this.generation += 1;
    if (value !== undefined) this.emit(value);
  }

  clear(): void {
    this.pending = undefined;
    this.scheduled = false;
    this.generation += 1;
  }
}
