/**
 * Does this runtime emit the format it claims to?
 *
 * The trace is a published interchange artifact (`30-scenarios.md` section 7), and for a long while
 * nothing checked that the sandbox produced it — the specification said six lines and the only
 * definition was the TypeScript in this repository, which is the one place a consumer is told not to
 * read. Spider found four divergences on its first day as a consumer: a bare `service` where
 * everything else was qualified, a `seq` that restarted per run so a file of two runs had two events
 * numbered 0, a `correlation` field declared and never emitted, and no field order at all.
 *
 * So this is the test that makes the claim real. Core validates, this runtime produces, and a
 * divergence fails here rather than in whatever tool reads the output next.
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { TRACE_KINDS, readTrace, validateTrace, type TraceEvent } from "@sevenk/core";
import { run } from "../src/load.js";

const EXAMPLES = resolvePath(import.meta.dirname, "..", "..", "7K", "examples");
const present = existsSync(EXAMPLES);

interface Run {
  readonly name: string;
  readonly events: readonly TraceEvent[];
}

const gather = async (): Promise<Run[]> => {
  const report = await run(
    ["shop.scenario.7k", "soldout.scenario.7k"].map((f) => resolvePath(EXAMPLES, f)),
    { soaks: true },
  );
  return report.files
    .flatMap((f) => f.scenarios)
    .map((s) => ({ name: s.name, events: s.trace.all() }));
};

// Run once and share, because every test below reads the same traces and the soak in them takes a
// second and a half. Determinism is what makes sharing safe — and one test proves it by gathering a
// second time and comparing bytes.
let gathered: Promise<Run[]> | undefined;
const everyScenario = (): Promise<Run[]> => (gathered ??= gather());

describe.skipIf(!present)("the trace this runtime writes", () => {
  it("is valid by every rule section 7 states", async () => {
    const problems: string[] = [];
    for (const { name, events } of await everyScenario()) {
      for (const p of validateTrace(events)) problems.push(`${name}: ${p.message}`);
    }
    expect(problems).toEqual([]);
  });

  it("round-trips through the reader it publishes for", async () => {
    // What a consumer actually does: read the NDJSON back. If this loses an event or changes one,
    // every tool downstream is reading something other than what ran.
    for (const { name, events } of await everyScenario()) {
      const { events: back, problems } = readTrace(
        events.length === 0 ? "" : events.map((e) => JSON.stringify(e)).join("\n"),
      );
      expect(problems, name).toEqual([]);
      expect(back, name).toEqual([...events]);
    }
  });

  it("gives every run a distinct identity, so a file of several is unambiguous", async () => {
    // The gap that made this field exist: concatenating two scenarios' traces produced two events
    // numbered 0, and a consumer keying on `seq` merged them.
    const scenarios = await everyScenario();
    const runs = scenarios.map((s) => s.events[0]?.run).filter((r) => r !== undefined);
    expect(runs.length).toBeGreaterThan(1);
    expect(new Set(runs).size).toBe(runs.length);

    const all = scenarios.flatMap((s) => s.events);
    const keys = all.map((e) => `${e.run}\u0000${e.seq}`);
    expect(new Set(keys).size, "every (run, seq) is unique across a concatenated file").toBe(
      keys.length,
    );
  });

  it("names the scenario and the seed in the run, which is what reproduces it", async () => {
    for (const { name, events } of await everyScenario()) {
      if (events.length === 0) continue;
      expect(events[0]!.run, name).toMatch(/^.+#\d+$/);
      expect(events[0]!.run.startsWith(`${name}#`), `${name} vs ${events[0]!.run}`).toBe(true);
    }
  });

  it("qualifies every name a consumer has to resolve", async () => {
    // Section 7.6. A bare name leaves a consumer unable to tell two packages' services apart.
    const bare: string[] = [];
    for (const { name, events } of await everyScenario()) {
      for (const e of events) {
        for (const field of ["message", "pipe", "service", "saga", "schedule"] as const) {
          const value = e[field];
          if (value !== undefined && !value.includes(".")) {
            bare.push(`${name}#${e.seq} ${field}=${value}`);
          }
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it("emits no kind the format does not define", async () => {
    const kinds = new Set((await everyScenario()).flatMap((s) => s.events.map((e) => e.kind)));
    expect([...kinds].filter((k) => !TRACE_KINDS.includes(k))).toEqual([]);
  });

  it("writes the same bytes twice, so two runs of a scenario diff cleanly", async () => {
    // A trace is a bug report, and comparing two is how you see what a change did. That needs the
    // field order to be the format's rather than whichever branch built the object.
    const once = await everyScenario();
    const twice = await gather();
    for (const [i, { name, events }] of once.entries()) {
      expect(JSON.stringify(events), name).toBe(JSON.stringify(twice[i]!.events));
    }
  });
});
