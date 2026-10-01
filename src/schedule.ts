/**
 * Schedules: recurring work on the virtual clock.
 *
 * The interesting part is not the cron arithmetic (that is `cron.ts`) but **`onMissed`**,
 * which 7K makes required because no safe default exists — `skip` loses thirty hours of
 * settlement, `all` sends thirty notifications (`docs/spec/04-process.md` section 2.2).
 *
 * In a simulation there is no outage, so it would be easy to conclude `onMissed` can
 * never apply and leave it unimplemented. But the spec supplies the case itself: **a
 * schedule never overlaps itself**, one occurrence is in flight at a time, and an
 * occurrence still running when the next is due is a `schedule-overrun`. That overrun is
 * precisely a missed occurrence, so `onMissed` decides what happens to it — and all three
 * policies become observable and testable without inventing a way to fake downtime.
 *
 * An occurrence is **in flight** from the moment its message is published until that
 * message is handled, dead-lettered or dropped. That is the only definition available
 * from outside a service, which is as it should be: the model describes interfaces, not
 * internals.
 */

import {
  qualify,
  type JsonValue,
  type LinkedModel,
  type MessageIr,
  type ScheduleIr,
  type SendIr,
  type ServiceIr,
} from "@sevenk/core";
import { isCronProblem, knownZone, nextFiring, parseCron, type Cron } from "./cron.js";
import type { ScheduledEvent, VirtualTime } from "./clock.js";
import type { TraceEvent } from "./trace.js";

export interface ScheduleHost {
  readonly model: LinkedModel;
  /** Whether a package is one the scenario can name. */
  inScope(pkg: string): boolean;
  now(): VirtualTime;
  record(event: Omit<TraceEvent, "seq">): TraceEvent;
  timer(at: VirtualTime, run: () => void): ScheduledEvent<unknown>;
  send(
    from: ServiceIr,
    message: MessageIr,
    body: Readonly<Record<string, JsonValue>>,
    envelope: Readonly<Record<string, JsonValue>>,
    claims: Readonly<Record<string, JsonValue>>,
  ): string | undefined;
  fill(
    message: MessageIr,
    written: Readonly<Record<string, JsonValue>>,
    at: VirtualTime,
  ): { body: Record<string, JsonValue>; generated: readonly string[] };
  note(text: string): void;
}

interface Armed {
  readonly decl: ScheduleIr;
  readonly cron: Cron;
  readonly zone: string;
  readonly service: ServiceIr;
  readonly message: MessageIr;
  readonly send: SendIr;
  /** The envelope id of the occurrence in flight, if any. */
  inFlight?: string | undefined;
  /** When the in-flight occurrence was published, for the overrun report. */
  inFlightSince?: VirtualTime | undefined;
  /** Occurrences that came due while one was in flight. */
  missed: VirtualTime[];
  fired: number;
}

export class Schedules {
  private readonly armed: Armed[] = [];
  /** Occurrence messages still in flight, by envelope id. */
  private readonly watching = new Map<string, Armed>();

  constructor(private readonly host: ScheduleHost) {
    for (const decl of this.host.model.decls) {
      if (decl.kind !== "schedule" || !this.host.inScope(decl.id.pkg)) continue;
      this.arm(decl);
    }
  }

  get count(): number {
    return this.armed.length;
  }

  private arm(decl: ScheduleIr): void {
    const name = qualify(decl.id);

    if (decl.cron === undefined) {
      this.host.note(`\`${name}\` declares no \`every\`, so there is nothing to fire`);
      return;
    }
    const cron = parseCron(decl.cron);
    if (isCronProblem(cron)) {
      this.host.note(`\`${name}\` has an invalid cron expression: ${cron.message}`);
      return;
    }

    // The timezone is required, never implied, so an absent one is not defaulted to UTC.
    if (decl.timezone === undefined) {
      this.host.note(`\`${name}\` declares no timezone, which \`every ... in ...\` requires`);
      return;
    }
    if (!knownZone(decl.timezone)) {
      this.host.note(`\`${name}\` names a timezone this runtime does not know: \`${decl.timezone}\``);
      return;
    }

    const send = decl.send;
    const message = send === undefined ? undefined : this.host.model.declFor(send.message);
    if (send === undefined || message === undefined || message.kind !== "message") {
      this.host.note(`\`${name}\` declares no \`send\`, so there is nothing to fire`);
      return;
    }

    const service = this.serviceFor(decl, message);
    if (service === undefined) {
      this.host.note(
        `\`${name}\` has no hosting service: nothing in \`${decl.id.pkg}\` declares ` +
          `\`emits ${qualify(message.id)}\`, so there is no pipe to fire onto`,
      );
      return;
    }

    if (decl.onMissed === undefined) {
      this.host.note(
        `\`${name}\` declares no \`onMissed\`, which is required because neither answer is safe; ` +
          "this run treats it as `skip`",
      );
    }

    this.armed.push({
      decl,
      cron,
      zone: decl.timezone,
      service,
      message,
      send,
      missed: [],
      fired: 0,
    });
  }

  /** The service whose `emits` routes the schedule's message (`04-process.md` 2.2). */
  private serviceFor(decl: ScheduleIr, message: MessageIr): ServiceIr | undefined {
    const services = this.host.model.decls.filter(
      (d): d is ServiceIr => d.kind === "service" && !d.external && d.id.pkg === decl.id.pkg,
    );
    return services.find((s) =>
      s.emits.some((e) => {
        const id = this.host.model.resolve(e.message);
        return id !== undefined && qualify(id) === qualify(message.id);
      }),
    );
  }

  /** Arms the first firing of every schedule, once the clock's start is settled. */
  start(): void {
    for (const armed of this.armed) this.armFrom(armed, this.host.now());
  }

  /**
   * Arms the next firing after `from`, and re-arms from there when it fires.
   *
   * One timer at a time, chained — and the chain continues whether or not an occurrence
   * is in flight, because a schedule's clock does not stop for a slow handler. That is
   * what makes an overrun something a run can actually observe.
   */
  private armFrom(armed: Armed, from: VirtualTime): void {
    const next = nextFiring(armed.cron, armed.zone, from);
    if (next === undefined) {
      this.host.note(
        `\`${qualify(armed.decl.id)}\` has no occurrence within five years of ` +
          `${new Date(from).toISOString()}`,
      );
      return;
    }

    // A guard, not an expectation: a timer at or before the present would be drained
    // immediately and arm another, so a cron edge case could melt the run down. The
    // search guarantees progress; this makes a future mistake loud instead of fatal.
    if (next <= this.host.now()) {
      this.host.note(
        `\`${qualify(armed.decl.id)}\` computed an occurrence at or before the present ` +
          `(${new Date(next).toISOString()}), so it has been stopped`,
      );
      return;
    }

    this.host.timer(next, () => {
      this.armFrom(armed, next);
      this.due(armed, next);
    });
  }

  private due(armed: Armed, at: VirtualTime): void {
    const name = qualify(armed.decl.id);

    if (armed.inFlight !== undefined) {
      // One occurrence at a time. The due one is missed, and `onMissed` decides later.
      armed.missed.push(at);
      this.host.record({
        at: this.host.now(),
        iso: new Date(this.host.now()).toISOString(),
        kind: "schedule-overrun",
        schedule: name,
        message: qualify(armed.message.id),
        detail:
          `the occurrence due at ${new Date(at).toISOString()} came while the one from ` +
          `${new Date(armed.inFlightSince ?? at).toISOString()} was still in flight`,
      });
      return;
    }

    this.fire(armed, at);
  }

  private fire(armed: Armed, at: VirtualTime): void {
    const written = this.payload(armed, at);
    const { body, generated } = this.host.fill(armed.message, written, at);
    if (generated.length > 0 && armed.fired === 0) {
      // Once per schedule, not once per occurrence: an hourly job would say it 8760 times.
      this.host.note(
        `\`${qualify(armed.decl.id)}\` sends \`${qualify(armed.message.id)}\` with ` +
          `${generated.map((g) => `\`${g}\``).join(", ")} generated: not named in the \`send\`, and a ` +
          "schedule carries no state to fill them from",
      );
    }

    const id = this.host.send(armed.service, armed.message, body, {}, {});
    armed.fired++;

    this.host.record({
      at: this.host.now(),
      iso: new Date(this.host.now()).toISOString(),
      kind: "schedule-fired",
      schedule: qualify(armed.decl.id),
      message: qualify(armed.message.id),
      ...(id === undefined ? {} : { id }),
      detail: `occurrence due ${new Date(at).toISOString()}`,
    });

    if (id === undefined) return;
    armed.inFlight = id;
    armed.inFlightSince = this.host.now();
    this.watching.set(id, armed);
  }

  /**
   * The body a `send` block asks for, read against the occurrence.
   *
   * `occurrence.due` is the instant it was **scheduled for** and `occurrence.date` that
   * instant's civil date in the schedule's own timezone. Neither is `$now`: a catch-up
   * fires late, so a settlement job told to use the current date would settle the wrong
   * day — which is exactly the bug `onMissed all` otherwise introduces.
   */
  private payload(armed: Armed, due: VirtualTime): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};

    for (const assign of armed.send.assigns) {
      const target = assign.target[0];
      if (target === undefined || assign.target.length > 1) continue;
      const source = assign.source;

      if (source.from === "literal") {
        out[target] = source.value;
        continue;
      }
      if (source.from !== "occurrence") {
        // `state` belongs to a saga and `message` to an `on` action; a schedule has
        // neither. A model error the checker should catch, reported rather than invented.
        this.host.note(
          `\`${qualify(armed.decl.id)}\` reads \`${source.from}\` in its \`send\`, which a schedule ` +
            "has no access to; only `occurrence` and a literal are available",
        );
        continue;
      }

      switch (source.path[0]) {
        case "due":
          out[target] = new Date(due).toISOString();
          break;
        case "date":
          // Civil, in the declared zone: `2026-03-29` means that date there, whatever
          // the UTC instant happens to be.
          out[target] = new Intl.DateTimeFormat("sv-SE", { timeZone: armed.zone }).format(due);
          break;
        default:
          this.host.note(
            `\`${qualify(armed.decl.id)}\` reads \`occurrence.${source.path.join(".")}\`, which is not ` +
              "a thing an occurrence has; it has `due` and `date`",
          );
          break;
      }
    }

    return out;
  }

  /**
   * An occurrence's message reached the end of its life, so the schedule is free again.
   *
   * Whether it was handled, dead-lettered or dropped does not matter: all three mean
   * nothing more will happen to it, which is the only thing a schedule needs to know.
   */
  settled(envelopeId: string): void {
    const armed = this.watching.get(envelopeId);
    if (armed === undefined) return;
    this.watching.delete(envelopeId);
    armed.inFlight = undefined;
    armed.inFlightSince = undefined;

    const missed = armed.missed;
    if (missed.length === 0) return;
    armed.missed = [];

    const policy = armed.decl.onMissed ?? "skip";
    this.host.record({
      at: this.host.now(),
      iso: new Date(this.host.now()).toISOString(),
      kind: "schedule-missed",
      schedule: qualify(armed.decl.id),
      message: qualify(armed.message.id),
      detail: `${missed.length} missed, onMissed ${policy}`,
    });

    switch (policy) {
      case "skip":
        // Dropped. The next scheduled time is already armed.
        return;
      case "once":
        // Catch-up collapsed to one, fired now.
        this.fire(armed, missed.at(-1)!);
        return;
      case "all":
        // Every one of them, which is right for settlement and catastrophic for
        // notifications. The first goes out now and becomes the in-flight occurrence; the
        // rest stay queued behind it and drain as each settles.
        armed.missed = missed.slice(1);
        this.fire(armed, missed[0]!);
        return;
    }
  }
}
