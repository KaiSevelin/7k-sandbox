import { describe, expect, it } from "vitest";
import { firingsBetween, isCronProblem, knownZone, nextFiring, parseCron, type Cron } from "../src/cron.js";

const cron = (text: string): Cron => {
  const parsed = parseCron(text);
  if (isCronProblem(parsed)) throw new Error(parsed.message);
  return parsed;
};

/** The firing rendered in its own zone, which is the only reading that is checkable. */
const at = (text: string, zone: string, from: string): string => {
  const next = nextFiring(cron(text), zone, Date.parse(from));
  if (next === undefined) return "never";
  return new Date(next).toLocaleString("sv-SE", { timeZone: zone, hour12: false });
};

describe("parsing", () => {
  it("reads every field form", () => {
    expect(cron("*/15 9-17 1,15 * mon-fri")).toMatchObject({
      minutes: new Set([0, 15, 30, 45]),
      hours: new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]),
      daysOfMonth: new Set([1, 15]),
      months: null,
      daysOfWeek: new Set([1, 2, 3, 4, 5]),
    });
  });

  it("accepts 7 for Sunday, because half the world writes it that way", () => {
    expect(cron("0 0 * * 7").daysOfWeek).toEqual(new Set([0]));
  });

  it("reports a bad expression rather than throwing", () => {
    for (const bad of ["0 0 * *", "61 * * * *", "0 0 * * 9", "0 0 * * mon/0", "x * * * *"]) {
      expect(isCronProblem(parseCron(bad)), bad).toBe(true);
    }
  });
});

describe("the next firing", () => {
  it("finds a daily schedule in its declared zone", () => {
    expect(at("0 2 * * *", "Europe/Stockholm", "2026-03-01T00:00:00Z")).toBe("2026-03-01 02:00:00");
  });

  it("is strictly after the instant given, so a firing never repeats itself", () => {
    const c = cron("0 2 * * *");
    const first = nextFiring(c, "UTC", Date.parse("2026-03-01T00:00:00Z"))!;
    expect(nextFiring(c, "UTC", first)).toBe(first + 86_400_000);
  });

  it("jumps to the right month for a yearly schedule without stepping through it", () => {
    const started = Date.now();
    expect(at("0 2 1 1 *", "UTC", "2026-02-01T00:00:00Z")).toBe("2027-01-01 02:00:00");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("ors the two day fields when both are restricted, as cron has always done", () => {
    // The 1st of the month, or any Monday.
    const c = cron("0 0 1 * mon");
    const days: string[] = [];
    let t = Date.parse("2026-06-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      t = nextFiring(c, "UTC", t)!;
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    // 1 June 2026 is a Monday; then the following Mondays, then 1 July.
    expect(days).toEqual(["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-01"]);
  });

  it("ands them when only one is restricted", () => {
    const c = cron("0 0 15 * *");
    const t = nextFiring(c, "UTC", Date.parse("2026-06-01T00:00:00Z"))!;
    expect(new Date(t).toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("returns nothing for a date that cannot occur", () => {
    expect(nextFiring(cron("0 0 30 2 *"), "UTC", 0)).toBeUndefined();
  });
});

describe("daylight saving", () => {
  // The timezone is required precisely because these two cases are decisions
  // (`04-process.md` 2.2). The sandbox's answer is: never twice, never skipped.
  it("fires once across a fall-back, not twice", () => {
    // Stockholm repeats 02:00-03:00 on 25 October 2026.
    const c = cron("30 2 * * *");
    const firings = firingsBetween(
      c,
      "Europe/Stockholm",
      Date.parse("2026-10-24T00:00:00Z"),
      Date.parse("2026-10-26T12:00:00Z"),
    );
    const onTheDay = firings.filter(
      (f) =>
        new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(f) === "2026-10-25",
    );
    // The repeated hour contains 02:30 twice in local terms; it must fire once.
    expect(onTheDay).toHaveLength(1);
    // One per day across the window, with no day doubled.
    expect(new Set(firings.map((f) => new Date(f).toISOString().slice(0, 10))).size).toBe(firings.length);
  });

  it("still fires on a day whose local time was skipped by a spring-forward", () => {
    // Stockholm jumps 02:00 -> 03:00 on 29 March 2026, so 02:30 does not exist.
    const next = nextFiring(cron("30 2 * * *"), "Europe/Stockholm", Date.parse("2026-03-28T12:00:00Z"));
    expect(next).toBeDefined();
    expect(new Date(next!).toISOString().slice(0, 10)).toBe("2026-03-29");
  });

  it("keeps a declared local hour across a transition rather than drifting with UTC", () => {
    const c = cron("0 2 * * *");
    const before = nextFiring(c, "Europe/Stockholm", Date.parse("2026-03-27T12:00:00Z"))!;
    const after = nextFiring(c, "Europe/Stockholm", Date.parse("2026-03-30T12:00:00Z"))!;
    const local = (t: number): string =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", hour12: false }).format(t);
    expect(local(before)).toBe(local(after));
  });
});

describe("zones", () => {
  it("recognises a real zone and declines an invented one", () => {
    expect(knownZone("Europe/Stockholm")).toBe(true);
    expect(knownZone("Mars/Olympus")).toBe(false);
  });
});

describe("firings in a window", () => {
  it("counts what a gap swallowed, which is what onMissed needs", () => {
    const firings = firingsBetween(
      cron("0 * * * *"),
      "UTC",
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-01-02T06:00:00Z"),
    );
    expect(firings).toHaveLength(30);
  });
});
