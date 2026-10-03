/**
 * A `best-effort` publication, lost.
 *
 * The failure this exists to make visible: a handler completed, its work committed, and the message it was
 * supposed to emit never appeared. No retry helps, because delivery never started. No `once per` key
 * helps, because nothing arrived to deduplicate. No dead letter holds it, because there is nothing to
 * dead-letter.
 *
 * "A runtime should be hostile in proportion to the declared guarantee" (`00-overview.md`), so the point
 * of these is that the sandbox really loses it — and that it does so only when the model said it might.
 */

import { describe, expect, it } from "vitest";
import { run as runScenario } from "./harness.js";

const MODEL = `package acme

message Ping v1.0 @event { id: uuid @role(businessKey) }
message Beat v1.0 @event { id: uuid @role(businessKey) }

pipe events : topic { retention 7d }

service Source {
  emits Ping to events
  emits Beat to events best-effort
}

service Sink {
  reacts Ping from events { replies none }
  reacts Beat from events { replies none }
}
`;

const SCENARIOS = `scenarios for acme

scenario Both {
  seed 7

  at 0s publish Ping as Source { id: "11111111-1111-7111-8111-111111111111" }
  at 0s publish Beat as Source { id: "22222222-2222-7222-8222-222222222222" }
  advance 1s
}
`;

/** Runs the scenario once at a given seed, with or without chaos. */
async function run(seed: number, chaos: boolean) {
  const result = await runScenario(MODEL, SCENARIOS, "Both", { chaos, seed });
  return result.trace.all();
}

describe("without chaos", () => {
  it("publishes a best-effort emit like any other", async () => {
    // A declaration that something may be lost is not a promise that it will be. A suite where every
    // best-effort emit vanished one run in twenty would be a suite nobody could read.
    const events = await run(7, false);
    expect(events.filter((e) => e.kind === "unpublished")).toEqual([]);
    expect(events.filter((e) => e.kind === "published")).toHaveLength(2);
  });
});

describe("under chaos", () => {
  it("loses a best-effort publication at some seed, and never an atomic one", async () => {
    // Seeded, so a lost publication is a model plus a number. Several seeds, because a 1-in-20 chance
    // means most of them publish normally — which is the point.
    const lost: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const events = await run(seed, true);
      const gone = events.filter((e) => e.kind === "unpublished");
      if (gone.length > 0) {
        lost.push(seed);
        // Only ever the one that said it might be.
        for (const e of gone) expect(e.message).toBe("acme.Beat");
      }
    }
    expect(lost.length, "no seed in 60 lost a best-effort publication").toBeGreaterThan(0);
  });

  it("says plainly that there is nothing to find", async () => {
    const seeds = [...Array(60)].map((_, i) => i + 1);
    for (const seed of seeds) {
      const events = await run(seed, true);
      const gone = events.find((e) => e.kind === "unpublished");
      if (gone === undefined) continue;

      expect(gone.pipe).toBe("acme.events");
      expect(gone.service).toBe("acme.Source");
      expect(gone.detail).toContain("no dead letter");

      // The thing that makes this different from every other loss: no `published` for it, so no
      // delivery, no dead letter, no retry. The message simply never existed.
      const sameMessage = events.filter((e) => e.message === "acme.Beat");
      expect(sameMessage.map((e) => e.kind)).toEqual(["unpublished"]);
      return;
    }
    expect.fail("no seed in 60 lost a publication");
  });

  it("still publishes the atomic emit in the same run", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const events = await run(seed, true);
      if (!events.some((e) => e.kind === "unpublished")) continue;
      // The loss is per publication, not per run: `Ping` was atomic and went through.
      expect(events.some((e) => e.kind === "published" && e.message === "acme.Ping")).toBe(true);
      return;
    }
    expect.fail("no seed in 60 lost a publication");
  });
});
