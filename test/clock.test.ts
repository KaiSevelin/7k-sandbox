import { describe, expect, it } from "vitest";
import { Clock, EventQueue, Rng } from "../src/clock.js";

describe("the virtual clock", () => {
  it("starts at a fixed instant, so a run with no declared start is still reproducible", () => {
    expect(new Clock().iso()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("refuses to move backwards", () => {
    const clock = new Clock();
    clock.jumpTo(clock.now() + 1000);
    expect(() => clock.jumpTo(clock.now() - 1)).toThrow(/cannot move backwards/);
  });

  it("is anchored, so a schedule could read a calendar off it", () => {
    const clock = new Clock({ start: Date.UTC(2026, 2, 15, 9, 30) });
    expect(clock.civil().getUTCDay()).toBe(0); // 15 March 2026 is a Sunday
  });
});

describe("the event queue", () => {
  it("orders by time, then by insertion, so ties are reproducible", () => {
    const q = new EventQueue<string>();
    q.schedule(100, "b");
    q.schedule(50, "a");
    q.schedule(100, "c");

    expect([q.take()?.payload, q.take()?.payload, q.take()?.payload]).toEqual(["a", "b", "c"]);
  });

  it("skips cancelled events without disturbing the order of the rest", () => {
    const q = new EventQueue<string>();
    q.schedule(1, "a");
    const b = q.schedule(2, "b");
    q.schedule(3, "c");
    b.cancelled = true;

    expect(q.size).toBe(2);
    expect([q.take()?.payload, q.take()?.payload]).toEqual(["a", "c"]);
  });
});

describe("the seeded generator", () => {
  it("gives the same sequence for the same seed", () => {
    const draw = (seed: number): number[] => {
      const rng = new Rng(seed);
      return [rng.int(100), rng.int(100), rng.int(100)];
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it("generates identifiers shaped like a uuid, so they satisfy the type", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 20; i++) {
      expect(rng.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
