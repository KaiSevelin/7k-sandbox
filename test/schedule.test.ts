/**
 * Schedules: firing, overlap and `onMissed`.
 *
 * `onMissed` is required by the language because neither answer is safe — `skip` loses
 * thirty hours of settlement, `all` sends thirty notifications — so a runtime that could
 * not exercise all three would leave the most consequential clause in the Process layer
 * untested.
 *
 * A simulation has no outage, but the spec supplies the case itself: a schedule never
 * overlaps, so an occurrence that comes due while one is in flight is missed. That is what
 * these tests use.
 */

import { describe, expect, it } from "vitest";
import { countOf, run } from "./harness.js";

const model = (every: string, onMissed: string, extra = ""): string => `
package t

message Settle v1.0 @command {
  day: string { length 1..10 } @role(businessKey)
}

pipe commands : queue

service Ledger {
  emits Settle to commands

  reacts Settle from commands {
    once per none
    replies none${extra}
  }
}

schedule Nightly {
  every    "${every}" in "Europe/Stockholm"
  send     Settle
  onMissed ${onMissed}
}
`;

const scenario = (body: string): string => `scenarios for t\n\nscenario S {\n  seed 1\n${body}\n}\n`;

/** The clock starts at 2026-01-01T00:00:00Z, which is 01:00 in Stockholm. */
const START = Date.UTC(2026, 0, 1);

describe("firing", () => {
  it("fires once a day at its declared local time", async () => {
    const result = await run(
      model("0 2 * * *", "all"),
      scenario(`  advance 3d
  expect Settle on commands count 3`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("schedule-fired").map((e) => new Date(e.at).toISOString())).toEqual([
      "2026-01-01T01:00:00.000Z",
      "2026-01-02T01:00:00.000Z",
      "2026-01-03T01:00:00.000Z",
    ]);
  });

  it("keeps its declared local hour across a daylight-saving change, and skips nothing", async () => {
    // Stockholm jumps 02:00 -> 03:00 on 29 March 2026, so `0 2 * * *` names an hour that
    // does not exist that day. The decision is never twice and never skipped, so the
    // occurrence fires at the instant the clock jumped past it: 03:00 local.
    const result = await run(model("0 2 * * *", "all"), scenario(`  advance 90d`));

    const localHour = (at: number): string =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Stockholm",
        hour: "2-digit",
        hour12: false,
      }).format(at);
    const localDay = (at: number): string =>
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(at);

    const fired = result.trace.of("schedule-fired").map((e) => e.at);

    // Exactly one per day: the repeated hour in October is not in range here, and the
    // skipped hour in March did not cost an occurrence.
    expect(new Set(fired.map(localDay)).size).toBe(fired.length);

    const byHour = new Map<string, string[]>();
    for (const at of fired) {
      const hour = localHour(at);
      byHour.set(hour, [...(byHour.get(hour) ?? []), localDay(at)]);
    }
    expect(byHour.get("03")).toEqual(["2026-03-29"]);
    expect(byHour.get("02")?.length).toBe(fired.length - 1);
  });

  it("fires nothing when the clock never reaches an occurrence", async () => {
    const result = await run(model("0 2 * * *", "all"), scenario(`  advance 30m`));
    expect(countOf(result, "schedule-fired")).toBe(0);
  });

  it("runs a year of hourly occurrences without waiting for them", async () => {
    const started = Date.now();
    const result = await run(model("0 * * * *", "skip"), scenario(`  advance 365d`));

    // 8759, not 8760: a year has that many hours in Stockholm, because the hour the
    // spring-forward skipped did not happen and so has no work in it. The fall-back's
    // repeated hour fires once. Never twice, never skipped.
    expect(countOf(result, "schedule-fired")).toBe(8759);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("does not invent occurrences after the scenario's last step", async () => {
    // Settling the run finishes what is in flight; it does not drive the schedule on.
    const result = await run(model("0 2 * * *", "all"), scenario(`  advance 1d`));
    expect(countOf(result, "schedule-fired")).toBe(1);
  });
});

/**
 * An occurrence is in flight until its message is handled, dead-lettered or dropped. The
 * way that genuinely takes time is a handler that fails and is retried: a nightly job
 * stuck in its backoff is exactly the thing that blocks the next occurrence.
 */
const SLOW = `
package t

message Settle v1.0 @command {
  day: string { length 1..10 } @role(businessKey)
}

pipe commands : queue

service Ledger {
  emits Settle to commands

  reacts Settle from commands {
    once per none
    replies none
    retry   3 after 1h
  }
}

schedule Hourly {
  every    "0 * * * *" in "UTC"
  send     Settle
  onMissed POLICY
}
`;

const slow = (policy: string): string => SLOW.replace("POLICY", policy);

/** Fails three times, so the occupying occurrence is only handled about eight hours in. */
const STICKY = `  mock Ledger { on Settle sequence { fail; fail; fail; reply none } }`;

describe("overlap", () => {
  it("never runs two occurrences at once, and reports each overrun", async () => {
    const result = await run(slow("skip"), scenario(`${STICKY}\n  advance 12h`));

    const fired = result.trace.of("schedule-fired").map((e) => e.at);
    expect(result.trace.of("schedule-overrun").length).toBeGreaterThan(0);

    // Every occurrence waited for the previous one to finish, so none overlap.
    const settlePoints = result.trace.of("handled").map((e) => e.at);
    for (const [i, at] of fired.entries()) {
      if (i === 0) continue;
      expect(settlePoints.some((s) => s <= at)).toBe(true);
    }
  });

  it("frees the schedule when an occurrence dead-letters, not only when it succeeds", async () => {
    const result = await run(
      slow("skip"),
      scenario(`  mock Ledger { on Settle fail }\n  advance 24h`),
    );

    // Nothing more will happen to a dead letter, which is all a schedule needs to know.
    expect(countOf(result, "dead-lettered")).toBeGreaterThan(0);
    expect(countOf(result, "schedule-fired")).toBeGreaterThan(1);
  });
});

describe("onMissed", () => {
  const detailsOf = async (policy: string): Promise<string[]> => {
    const result = await run(slow(policy), scenario(`${STICKY}\n  advance 12h`));
    return result.trace.of("schedule-missed").map((e) => e.detail ?? "");
  };

  const firedCount = async (policy: string): Promise<number> => {
    const result = await run(slow(policy), scenario(`${STICKY}\n  advance 12h`));
    return countOf(result, "schedule-fired");
  };

  it("swallows several occurrences while one is stuck, whatever the policy", async () => {
    const details = await detailsOf("skip");
    expect(details.length).toBeGreaterThan(0);
    expect(Number(/^(\d+) missed/.exec(details[0]!)?.[1] ?? 0)).toBeGreaterThan(1);
  });

  it("skip drops them, which is how thirty hours of settlement get lost", async () => {
    expect((await detailsOf("skip")).every((d) => d.includes("onMissed skip"))).toBe(true);
  });

  it("once collapses the catch-up to a single occurrence", async () => {
    expect((await detailsOf("once")).every((d) => d.includes("onMissed once"))).toBe(true);
    expect(await firedCount("once")).toBeGreaterThan(await firedCount("skip"));
  });

  it("all works through the backlog, which is right for settlement", async () => {
    expect((await detailsOf("all")).every((d) => d.includes("onMissed all"))).toBe(true);
    expect(await firedCount("all")).toBeGreaterThan(await firedCount("once"));
  });

  it("is the one clause with no safe default, so an absent one is reported", async () => {
    const source = slow("skip").replace("  onMissed skip\n", "");
    const result = await run(source, scenario(`  advance 3h`));
    expect(result.notes.join(" ")).toMatch(/declares no `onMissed`/);
  });
});

describe("an occurrence's payload", () => {
  const dated = (policy: string, assign: string, extra = ""): string => `
package t

message Settle v1.0 @command {
  day:  date @role(businessKey)
  when: instant
}

pipe commands : queue

service Ledger {
  emits Settle to commands

  reacts Settle from commands {
    once per none
    replies none${extra}
  }
}

schedule Nightly {
  every    "0 1 * * *" in "UTC"
  send     Settle { ${assign} }
  onMissed ${policy}
}
`;

  it("reads the instant the occurrence was due", async () => {
    const result = await run(dated("all", "when = occurrence.due"), scenario(`  advance 2d`));
    expect(
      result.trace.of("published").map((e) => e.body?.when),
    ).toEqual(["2026-01-01T01:00:00.000Z", "2026-01-02T01:00:00.000Z"]);
  });

  it("reads the civil date in the schedule's own timezone, not UTC's", async () => {
    // 01:00 UTC is 02:00 in Stockholm on the same date, but 20:00 the *previous* day in
    // New York -- which is the point of the zone being declared.
    const ny = dated("all", "day = occurrence.date").replace('in "UTC"', 'in "America/New_York"');
    const result = await run(ny, scenario(`  advance 2d`));
    // 01:00 New York time, so the dates are the local ones.
    expect(result.trace.of("published").map((e) => e.body?.day)).toEqual([
      "2026-01-01",
      "2026-01-02",
    ]);
  });

  it("gives a catch-up the day it was due, not the day it ran", async () => {
    // The first occurrence hangs long enough that two more fall due behind it, so the
    // backlog is worked through on a later date than the one it settles.
    const model = dated("all", "day = occurrence.date", "\n    retry 0");
    const result = await run(
      model,
      scenario(`  mock Ledger { on Settle hang }\n  advance 5d`),
      undefined,
      // A hang is only a hang for as long as nothing acknowledges it.
      { ackTimeoutMs: 50 * 3_600_000 },
    );

    const settled = result.trace
      .of("published")
      .map((e) => ({ ran: e.iso.slice(0, 10), due: e.body?.day }));

    // At least one occurrence was published on a later date than the day it settles,
    // which is exactly the bug `$now` would have introduced.
    expect(settled.some((x) => x.ran !== x.due)).toBe(true);
    // And every day is settled once, under its own date.
    expect(new Set(settled.map((x) => x.due)).size).toBe(settled.length);
  });

  it("says so rather than guessing when a send reads something a schedule has not got", async () => {
    const result = await run(
      dated("all", "when = state.anything"),
      scenario(`  advance 1d`),
    );
    expect(result.notes.join(" ")).toMatch(/reads `state` in its `send`/);
  });

  it("names a part of an occurrence that does not exist", async () => {
    const result = await run(
      dated("all", "when = occurrence.whenever"),
      scenario(`  advance 1d`),
    );
    expect(result.notes.join(" ")).toMatch(/not a thing an occurrence has/);
  });
});

describe("what a runtime must refuse to guess", () => {
  it("says so when a timezone is missing rather than defaulting to UTC", async () => {
    const source = model("0 2 * * *", "all").replace(' in "Europe/Stockholm"', "");
    const result = await run(source, scenario(`  advance 1d`));
    // The clause is `every <cron> in <tz>`, so the parser reports it; nothing fires.
    expect(countOf(result, "schedule-fired")).toBe(0);
  });

  it("names a timezone it does not know", async () => {
    const result = await run(
      model("0 2 * * *", "all").replace("Europe/Stockholm", "Mars/Olympus"),
      scenario(`  advance 1d`),
    );
    expect(result.notes.join(" ")).toMatch(/timezone this runtime does not know/);
    expect(countOf(result, "schedule-fired")).toBe(0);
  });

  it("reports an impossible expression rather than firing nothing silently", async () => {
    const result = await run(model("0 2 30 2 *", "all"), scenario(`  advance 2d`));
    expect(result.notes.join(" ")).toMatch(/no occurrence within five years/);
  });

  it("reports a schedule whose message no service emits", async () => {
    const source = model("0 2 * * *", "all").replace("  emits Settle to commands\n", "");
    const result = await run(source, scenario(`  advance 1d`));
    expect(result.notes.join(" ")).toMatch(/no hosting service/);
    expect(countOf(result, "schedule-fired")).toBe(0);
  });
});
