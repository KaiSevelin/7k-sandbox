/**
 * The virtual clock and the deterministic event queue.
 *
 * This is where the sandbox's value comes from, so it is worth stating the
 * mechanism plainly. Events are ordered by `(time, sequence)`. The loop drains
 * everything due at the current instant until **quiescent** — nothing left to do
 * now — and then jumps the clock straight to the next scheduled event.
 *
 * That is why `advance 30d` finishes in microseconds: nothing is waited on, and
 * the clock teleports between interesting moments. And it is *sound* rather than
 * approximate only because 7K forbids a service from reading a wall clock
 * (`docs/spec/04-process.md` section 2.1) — one `Date.now()` in a handler and
 * fast-forwarding stops telling the truth.
 *
 * The clock is an anchored civil datetime with a timezone, not a counter, because
 * a `schedule` needs to know the day of the week.
 */

/** Milliseconds since the Unix epoch, on the virtual timeline. */
export type VirtualTime = number;

export interface ScheduledEvent<T> {
  readonly at: VirtualTime;
  /** Breaks ties in insertion order, so a run is reproducible. */
  readonly seq: number;
  readonly payload: T;
  /** Set when cancelled: a step completing early cancels its own timeout. */
  cancelled?: boolean;
}

export interface ClockOptions {
  /** The instant the run begins. Anchored, so `schedule` can read a calendar. */
  readonly start?: VirtualTime;
  readonly timezone?: string;
}

/**
 * A priority queue over `(at, seq)`.
 *
 * A sorted array rather than a heap: a scenario's event count is small, and the
 * array keeps iteration order inspectable, which matters when a test is asking
 * *why* two deliveries landed in that order.
 */
export class EventQueue<T> {
  private events: ScheduledEvent<T>[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.events.filter((e) => e.cancelled !== true).length;
  }

  schedule(at: VirtualTime, payload: T): ScheduledEvent<T> {
    const event: ScheduledEvent<T> = { at, seq: this.nextSeq++, payload };
    // Inserted in order, so `peek` is the front and ties keep insertion order.
    const i = this.events.findIndex((e) => e.at > at || (e.at === at && e.seq > event.seq));
    if (i < 0) this.events.push(event);
    else this.events.splice(i, 0, event);
    return event;
  }

  peek(): ScheduledEvent<T> | undefined {
    for (const e of this.events) if (e.cancelled !== true) return e;
    return undefined;
  }

  /** The next event, removed. */
  take(): ScheduledEvent<T> | undefined {
    while (this.events.length > 0) {
      const next = this.events.shift()!;
      if (next.cancelled !== true) return next;
    }
    return undefined;
  }

  /** Discards cancelled events that have accumulated at the front. */
  compact(): void {
    this.events = this.events.filter((e) => e.cancelled !== true);
  }

  /** Everything still pending, for a diagnostic about a stuck run. */
  pending(): readonly ScheduledEvent<T>[] {
    return this.events.filter((e) => e.cancelled !== true);
  }
}

export class Clock {
  private current: VirtualTime;
  readonly timezone: string;

  constructor(options: ClockOptions = {}) {
    // A fixed default so a run with no explicit start is still reproducible.
    this.current = options.start ?? Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    this.timezone = options.timezone ?? "UTC";
  }

  now(): VirtualTime {
    return this.current;
  }

  /**
   * Moves the clock forward. Never backward: an event scheduled in the past is a
   * programming error in the engine, not a condition to model.
   */
  jumpTo(at: VirtualTime): void {
    if (at < this.current) {
      throw new Error(`the virtual clock cannot move backwards: ${this.current} -> ${at}`);
    }
    this.current = at;
  }

  /** The civil datetime, for a `schedule` that needs the day of the week. */
  civil(): Date {
    return new Date(this.current);
  }

  /** `2026-01-01T00:00:30.000Z` — how a trace renders an instant. */
  iso(): string {
    return new Date(this.current).toISOString();
  }
}

/**
 * A seeded generator, so every nondeterministic choice in a run draws from one
 * place: delivery order among competing consumers, injected faults, generated
 * identifiers, weighted mock outcomes.
 *
 * That is what makes a bug report a model plus a seed. mulberry32 — small, fast,
 * and good enough for choosing between outcomes; it is not for cryptography.
 */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [0, bound). */
  int(bound: number): number {
    return bound <= 0 ? 0 : Math.floor(this.next() * bound);
  }

  /** True with the given probability in percent. */
  chance(percent: number): boolean {
    return this.next() * 100 < percent;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.int(items.length)];
  }

  /** A deterministic identifier, shaped like a uuid so it satisfies the type. */
  uuid(): string {
    const hex = (n: number): string =>
      Array.from({ length: n }, () => "0123456789abcdef"[this.int(16)]).join("");
    return `${hex(8)}-${hex(4)}-7${hex(3)}-${"89ab"[this.int(4)]}${hex(3)}-${hex(12)}`;
  }
}
