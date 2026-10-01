/**
 * Cron expressions against an anchored civil calendar.
 *
 * A `schedule` declares a timezone and 7K **requires** it, because a local-time
 * schedule across a daylight-saving transition either fires twice or not at all, and
 * that is a decision rather than a default (`docs/spec/04-process.md` section 2.2). So
 * this works in local wall-clock terms and converts back, rather than pretending every
 * zone is a fixed offset from UTC.
 *
 * The decision taken here is **never twice and never skipped**. A local time the clock
 * jumped over fires at the end of the gap; a local time the clock repeated fires once.
 * For an hourly schedule the skipped hour then coincides with the next occurrence and
 * the two are a single firing, which is right: that hour did not happen, so it holds no
 * work. A year of `0 * * * *` in Stockholm is 8759 firings, not 8760.
 *
 * The search is coarse: it jumps to the next candidate month, day, hour and minute
 * rather than stepping a minute at a time, so finding the next occurrence of
 * `0 2 1 1 *` costs about a hundred iterations instead of half a million.
 */

import type { VirtualTime } from "./clock.js";

/** A parsed field: `null` means `*`, every value matching. */
type Field = ReadonlySet<number> | null;

export interface Cron {
  readonly minutes: Field;
  readonly hours: Field;
  readonly daysOfMonth: Field;
  readonly months: Field;
  readonly daysOfWeek: Field;
}

export interface CronProblem {
  readonly message: string;
}

const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  minutes: [0, 59],
  hours: [0, 23],
  daysOfMonth: [1, 31],
  months: [1, 12],
  daysOfWeek: [0, 6],
};

type FieldName = "minutes" | "hours" | "daysOfMonth" | "months" | "daysOfWeek";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function named(text: string, kind: FieldName): string {
  const lower = text.toLowerCase();
  if (kind === "months") {
    const i = MONTH_NAMES.indexOf(lower);
    return i < 0 ? text : String(i + 1);
  }
  if (kind === "daysOfWeek") {
    const i = DAY_NAMES.indexOf(lower);
    return i < 0 ? text : String(i);
  }
  return text;
}

/** One field of an expression: `*`, `5`, `1-5`, `1,3,5`, `*&#47;15`, `9-17/2`. */
function parseField(text: string, kind: FieldName): ReadonlySet<number> | null | CronProblem {
  const [lo, hi] = RANGES[kind]!;
  const trimmed = text.trim();
  if (trimmed === "*") return null;

  const out = new Set<number>();

  for (const part of trimmed.split(",")) {
    const [spec, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      return { message: `\`${part}\` has an invalid step` };
    }

    let from = lo;
    let to = hi;

    if (spec !== "*" && spec !== undefined && spec !== "") {
      const bounds = spec.split("-").map((b) => Number(named(b, kind)));
      if (bounds.some((b) => !Number.isInteger(b))) {
        return { message: `\`${part}\` is not a number, a range or a name` };
      }
      from = bounds[0]!;
      to = bounds.length > 1 ? bounds[1]! : stepText === undefined ? bounds[0]! : hi;
    }

    // Sunday is 0, and 7 is also accepted because half the world writes it that way.
    if (kind === "daysOfWeek") {
      if (from === 7) from = 0;
      if (to === 7) to = 0;
    }

    if (from < lo || to > hi || from > to) {
      return { message: `\`${part}\` is outside ${lo}..${hi}` };
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }

  return out.size === 0 ? { message: `\`${text}\` matches nothing` } : out;
}

/** Parses a five-field expression. Returns the problem rather than throwing. */
export function parseCron(text: string): Cron | CronProblem {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { message: `expected five fields (minute hour day month weekday), got ${fields.length}` };
  }

  const keys = ["minutes", "hours", "daysOfMonth", "months", "daysOfWeek"] as const;
  const parsed: Record<string, ReadonlySet<number> | null> = {};

  for (const [i, key] of keys.entries()) {
    const field = parseField(fields[i]!, key);
    if (field !== null && !(field instanceof Set)) return field as CronProblem;
    parsed[key] = field as ReadonlySet<number> | null;
  }

  return parsed as unknown as Cron;
}

export const isCronProblem = (v: Cron | CronProblem): v is CronProblem => "message" in v;

// ---- timezones --------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, found);
  }
  return found;
}

/** True when the runtime knows this zone, so an unknown one is reported rather than thrown. */
export function knownZone(zone: string): boolean {
  try {
    formatter(zone).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone's offset from UTC at an instant, in milliseconds.
 *
 * Measured rather than looked up: format the instant in the zone, read the result back
 * as though it were UTC, and the difference is the offset. That handles every
 * daylight-saving rule without this file knowing any of them.
 */
function offsetAt(zone: string, at: VirtualTime): number {
  const parts = formatter(zone).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Local wall-clock time expressed as a UTC instant, so plain arithmetic works on it. */
const toLocal = (zone: string, at: VirtualTime): number => at + offsetAt(zone, at);

/**
 * Back from local wall-clock to a real instant.
 *
 * The offset depends on the instant, which is what we are solving for, so there are two
 * plausible answers: the offset measured at the nominal instant, and the offset measured
 * at the instant that first answer implies. Across a daylight-saving transition they
 * differ, and the right one is **the earliest instant whose local time is at or after
 * what was asked for**.
 *
 * That single rule covers both hard cases. When the local time exists, it is an exact
 * match. When a spring-forward skipped it, the earliest qualifying instant is the end of
 * the gap — so the occurrence fires at the moment the clock jumped past it rather than
 * being silently lost. A naive iteration lands *before* the gap instead, whose local time
 * is earlier than requested, and then the same local minute is found again on the next
 * search: the schedule stops making progress.
 */
function fromLocal(zone: string, local: number): VirtualTime {
  const first = local - offsetAt(zone, local);
  const second = local - offsetAt(zone, first);

  const candidates = first === second ? [first] : [first, second].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (toLocal(zone, candidate) >= local) return candidate;
  }
  return candidates.at(-1)!;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Classic cron: when both day fields are restricted they are **or**-ed, not and-ed. */
function matchesDay(cron: Cron, dayOfMonth: number, dayOfWeek: number): boolean {
  const byDate = cron.daysOfMonth === null || cron.daysOfMonth.has(dayOfMonth);
  const byWeek = cron.daysOfWeek === null || cron.daysOfWeek.has(dayOfWeek);
  if (cron.daysOfMonth === null || cron.daysOfWeek === null) return byDate && byWeek;
  return byDate || byWeek;
}

/**
 * The first firing strictly after `after`.
 *
 * `undefined` when the expression matches nothing within a few years, which is what a
 * `31 2 * * *` style impossibility looks like.
 */
export function nextFiring(
  cron: Cron,
  zone: string,
  after: VirtualTime,
  withinDays = 5 * 366,
): VirtualTime | undefined {
  // Start at the next whole local minute, since cron has minute resolution.
  let local = Math.floor(toLocal(zone, after) / MINUTE) * MINUTE + MINUTE;
  const limit = local + withinDays * DAY;

  while (local < limit) {
    const d = new Date(local);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = d.getUTCDay();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();

    if (cron.months !== null && !cron.months.has(month)) {
      // The first instant of the next month, so a yearly schedule costs twelve steps.
      local = Date.UTC(d.getUTCFullYear() + (month === 12 ? 1 : 0), month === 12 ? 0 : month, 1);
      continue;
    }
    if (!matchesDay(cron, day, weekday)) {
      local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day) + DAY;
      continue;
    }
    if (cron.hours !== null && !cron.hours.has(hour)) {
      local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day, hour) + 3_600_000;
      continue;
    }
    if (cron.minutes !== null && !cron.minutes.has(minute)) {
      local += MINUTE;
      continue;
    }

    const at = fromLocal(zone, local);

    // Never twice and never skipped, which is the only pair of answers safe for both a
    // settlement job and a notification. An ambiguous local time — the hour a fall-back
    // repeats — yields one instant, so the occurrence fires once; which of the two it is
    // is not specified. A local time inside a spring-forward gap fires at the end of it.
    if (at > after) return at;

    // The candidate is not in the future, which happens around a transition. Step the
    // local clock on rather than nudging the instant: `local` strictly increases, so the
    // search always makes progress and a schedule can never re-arm at the same moment.
    local += MINUTE;
  }

  return undefined;
}

/**
 * Every firing in `(after, until]`.
 *
 * Needed by `onMissed`, which has to know how many occurrences a gap swallowed before
 * it can decide what to do about them.
 */
export function firingsBetween(
  cron: Cron,
  zone: string,
  after: VirtualTime,
  until: VirtualTime,
  cap = 10_000,
): VirtualTime[] {
  const out: VirtualTime[] = [];
  let at = after;
  for (let i = 0; i < cap; i++) {
    const next = nextFiring(cron, zone, at);
    if (next === undefined || next > until) return out;
    out.push(next);
    at = next;
  }
  return out;
}
