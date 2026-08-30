export interface ControlLeaseOptions<T> {
  isOpen: (client: T) => boolean;
  idleMs?: number;
  now?: () => number;
}

export class ControlLease<T> {
  private controller?: T;
  private lastActiveAt = 0;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ControlLeaseOptions<T>) {
    this.idleMs = options.idleMs ?? 90_000;
    this.now = options.now ?? Date.now;
  }

  request(client: T): boolean {
    const current = this.controller;
    const stale = current && this.now() - this.lastActiveAt > this.idleMs;
    if (!current || !this.options.isOpen(current) || stale || current === client) {
      this.takeover(client);
      return true;
    }
    return false;
  }

  takeover(client: T): void {
    this.controller = client;
    this.lastActiveAt = this.now();
  }

  touch(client: T): boolean {
    if (this.controller !== client) return false;
    this.lastActiveAt = this.now();
    return true;
  }

  release(client: T): boolean {
    if (this.controller !== client) return false;
    this.controller = undefined;
    return true;
  }

  stateFor(client: T): { granted: boolean; occupied: boolean } {
    return {
      granted: client === this.controller,
      occupied: Boolean(this.controller && client !== this.controller),
    };
  }
}
