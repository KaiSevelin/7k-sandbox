/**
 * Sagas: instances, steps, timeouts, deadlines and compensation.
 *
 * Four decisions shape this, and each one falls out of what the language already says
 * rather than from what is convenient to implement.
 *
 * **A saga observes its hosting service.** It is not a subscriber in its own right. The
 * service consumes the start message and the replies; the saga is that service's
 * process. The alternative — giving the saga its own subscription — would make it
 * *compete* with the service for every message on a queue, which is the wrong answer in
 * a way that nothing would catch. It also means the saga inherits the subscription's
 * deduplication, authorization and retry behaviour for free, which is what it should do.
 *
 * **Correlation reuses the business key.** An awaited message finds its instance by its
 * own `@role(businessKey)`, or by `keyed by` where the identities genuinely differ
 * (`docs/spec/04-process.md` section 1.1). No separate correlation mechanism exists,
 * and the correlation *id* is for grouping a trace, not for identifying an instance.
 *
 * **Compensation runs for completed steps only, in reverse.** A step that never
 * succeeded has nothing to reverse, and that asymmetry is the single most important
 * property a saga test can assert (section 1.4).
 *
 * **A compensation is not awaited.** Nothing in the language declares an outcome for
 * one — there is no `on` clause for a `undo with` — so the saga sends each inverse and
 * terminates. Waiting for something no declaration mentions would be the runtime
 * inventing semantics.
 */

import {
  qualify,
  type AssignIr,
  type JsonValue,
  type LinkedModel,
  type MessageIr,
  type SagaAction,
  type SagaIr,
  type SendIr,
  type ServiceIr,
  type StepIr,
  type Terminal,
} from "@sevenk/core";
import type { ScheduledEvent, VirtualTime } from "./clock.js";
import { readPath, type Claims, type Message } from "./message.js";
import { fieldSpec, validate } from "./schema.js";
import type { TraceEvent } from "./trace.js";

/** What the saga runtime needs from the engine, kept narrow so neither owns the other. */
export interface SagaHost {
  readonly model: LinkedModel;
  /** Whether a package is one the scenario can name. */
  inScope(pkg: string): boolean;
  now(): VirtualTime;
  record(event: Omit<TraceEvent, "seq">): TraceEvent;
  /** Deferred work on the virtual clock, cancellable because a step may finish early. */
  timer(at: VirtualTime, run: () => void): ScheduledEvent<unknown>;
  cancel(timer: ScheduledEvent<unknown> | undefined): void;
  /** Sends on a service's declared `emits` route, returning the envelope id it got. */
  send(
    from: ServiceIr,
    message: MessageIr,
    body: Readonly<Record<string, JsonValue>>,
    envelope: Readonly<Record<string, JsonValue>>,
    claims: Claims,
  ): string | undefined;
  /** Fills a body from a partial one, generating what is still missing. */
  fill(
    message: MessageIr,
    written: Readonly<Record<string, JsonValue>>,
    at: VirtualTime,
  ): { body: Record<string, JsonValue>; generated: readonly string[] };
  note(text: string): void;
}

/** A live or finished saga instance. */
export interface Instance {
  readonly saga: SagaIr;
  readonly key: string;
  readonly version?: string;
  /**
   * `running`, or the terminal state reached. The terminal names are the ones the
   * language already uses as `on` triggers, so there is one vocabulary rather than two.
   */
  status: "running" | Terminal;
  /** The step being awaited. Equals `steps.length` once every step has finished. */
  stepIndex: number;
  /** Step names that completed, in order, which is what unwinding reads in reverse. */
  readonly completed: string[];
  readonly state: Record<string, JsonValue>;
  readonly startedAt: VirtualTime;
  endedAt?: VirtualTime;
  /** Why it rejected, for the trace. */
  reason?: string;
  /**
   * The start message's envelope, carried onto everything the saga sends (D50).
   *
   * The envelope and *only* the envelope: a saga acts under the hosting service's own
   * identity, and the original subject travels as envelope data rather than as a
   * credential (`04-process.md` 1.8). A saga running for 24 hours cannot carry a
   * 15-minute token, so it does not try to.
   */
  readonly envelope: Readonly<Record<string, JsonValue>>;
  stepTimer?: ScheduledEvent<unknown> | undefined;
  deadlineTimer?: ScheduledEvent<unknown> | undefined;
  /** True once a step with no timeout is being awaited and no deadline bounds it. */
  unbounded: boolean;
}

const instanceKey = (saga: SagaIr, key: string): string => `${qualify(saga.id)}\u0000${key}`;

/** `state.total`, for a diagnostic that has to name what it could not read. */
const showSource = (a: AssignIr): string => {
  const source = a.source;
  if (source.from === "literal") return JSON.stringify(source.value);
  if (source.from === "absent") return "absent";
  return source.from === "path" ? source.path.join(".") : `${source.from}.${source.path.join(".")}`;
};

export class Sagas {
  private readonly instances = new Map<string, Instance>();
  /** The service hosting each saga, resolved once. */
  private readonly hosts = new Map<string, ServiceIr | undefined>();

  constructor(private readonly host: SagaHost) {
    for (const decl of this.host.model.decls) {
      if (decl.kind !== "saga" || !this.host.inScope(decl.id.pkg)) continue;
      const service = this.hostOf(decl);
      this.hosts.set(qualify(decl.id), service);
      if (service === undefined) {
        this.host.note(
          `\`${qualify(decl.id)}\` has no hosting service: nothing in \`${decl.id.pkg}\` reacts to ` +
            "its start message, so there is no `emits` table to route its sends through",
        );
      }
    }
  }

  get all(): readonly Instance[] {
    return [...this.instances.values()];
  }

  /**
   * Whether a message starting a saga this service hosts is what the subscription is for.
   *
   * A service hosting a saga *is* implemented as far as the model is concerned — the saga
   * is its handler — so an unmocked subscription that starts one is not an unscripted
   * service. Asking a scenario to mock the service under test would be noise, and the
   * noise would be on the one service the scenario is about.
   */
  startsASaga(service: ServiceIr, messageType: string): SagaIr | undefined {
    for (const saga of this.sagasHostedBy(service)) {
      const start = saga.start;
      if (start === undefined) continue;
      const id = this.host.model.resolve(start.message);
      if (id !== undefined && qualify(id) === messageType) return saga;
    }
    return undefined;
  }

  of(saga: string): Instance[] {
    return this.all.filter((i) => i.saga.id.name === saga || qualify(i.saga.id) === saga);
  }

  find(saga: SagaIr, key: string): Instance | undefined {
    return this.instances.get(instanceKey(saga, key));
  }

  /**
   * The service that hosts a saga: the one in the saga's package that consumes its start
   * message. Terminal and step sends route through that service's `emits`, so routing
   * stays in one table (`04-process.md` section 1.5).
   */
  private hostOf(saga: SagaIr): ServiceIr | undefined {
    const start = saga.start;
    if (start === undefined) return undefined;
    const startId = this.host.model.resolve(start.message);

    const services = this.host.model.decls.filter(
      (d): d is ServiceIr => d.kind === "service" && !d.external && d.id.pkg === saga.id.pkg,
    );

    const consumer = services.find((s) =>
      s.reacts.some((r) => {
        const id = this.host.model.resolve(r.message);
        return id !== undefined && startId !== undefined && qualify(id) === qualify(startId);
      }),
    );
    if (consumer !== undefined) return consumer;

    // A saga whose start message nothing consumes: fall back to whichever service can
    // route its first send, so a partly-written model still runs.
    const firstSend = saga.steps[0]?.send;
    if (firstSend === undefined) return undefined;
    const sendId = this.host.model.resolve(firstSend.message);
    return services.find((s) =>
      s.emits.some((e) => {
        const id = this.host.model.resolve(e.message);
        return id !== undefined && sendId !== undefined && qualify(id) === qualify(sendId);
      }),
    );
  }

  // ---- observing ------------------------------------------------------------

  /**
   * Called when a service has handled a message.
   *
   * Start first, then advance, because a message can legitimately be both — a saga
   * driven by another saga's terminal event (section 1.6).
   */
  observe(service: ServiceIr, message: Message): void {
    this.tryStart(service, message);
    this.tryAdvance(service, message);
  }

  private sagasHostedBy(service: ServiceIr): SagaIr[] {
    const out: SagaIr[] = [];
    for (const [name, host] of this.hosts) {
      if (host === undefined || host.id.name !== service.id.name || host.id.pkg !== service.id.pkg) {
        continue;
      }
      const decl = this.host.model.decls.find((d) => d.kind === "saga" && qualify(d.id) === name);
      if (decl?.kind === "saga") out.push(decl);
    }
    return out;
  }

  private tryStart(service: ServiceIr, message: Message): void {
    for (const saga of this.sagasHostedBy(service)) {
      const start = saga.start;
      if (start === undefined) continue;

      const id = this.host.model.resolve(start.message);
      if (id === undefined || qualify(id) !== message.envelope.type) continue;

      const key = this.keyOf(message, start.keyedBy);
      if (key === undefined) {
        this.host.note(
          `\`${qualify(saga.id)}\` cannot key an instance from \`${message.envelope.type}\`: it has ` +
            "no `@role(businessKey)` field and the saga declares no `keyed by`",
        );
        continue;
      }

      // Two messages with the same key reach the same instance, which is what makes a
      // duplicate start idempotent on an at-least-once pipe (section 1.1).
      const existing = this.instances.get(instanceKey(saga, key));
      if (existing !== undefined) {
        this.trace(existing, "saga-redundant-start", { detail: "a live instance already holds this key" });
        continue;
      }

      const instance: Instance = {
        saga,
        key,
        ...(saga.version === undefined ? {} : { version: saga.version }),
        status: "running",
        stepIndex: 0,
        completed: [],
        state: {},
        startedAt: this.host.now(),
        envelope: message.envelope.fields,
        unbounded: false,
      };

      this.assign(instance, start.assigns, message);
      this.instances.set(instanceKey(saga, key), instance);
      this.trace(instance, "saga-started");

      if (saga.deadlineMs !== undefined) {
        instance.deadlineTimer = this.host.timer(this.host.now() + saga.deadlineMs, () => {
          // A deadline abandons the whole saga, wherever it had got to (section 1.5).
          if (instance.status === "running") this.terminate(instance, "abandon", "deadline elapsed");
        });
      }

      this.enterStep(instance);
    }
  }

  private tryAdvance(service: ServiceIr, message: Message): void {
    for (const instance of this.instances.values()) {
      if (instance.status !== "running") continue;

      const hostService = this.hosts.get(qualify(instance.saga.id));
      if (hostService?.id.name !== service.id.name || hostService.id.pkg !== service.id.pkg) continue;

      const step = instance.saga.steps[instance.stepIndex];
      if (step === undefined) continue;

      for (const awaited of step.awaits) {
        const id = this.host.model.resolve(awaited.message);
        if (id === undefined || qualify(id) !== message.envelope.type) continue;

        const key = this.keyOf(message, awaited.keyedBy);
        if (key === undefined || key !== instance.key) continue;

        this.trace(instance, "saga-advanced", { message: message.envelope.type, detail: step.name });
        this.act(instance, step, awaited.action, message);
        return;
      }
    }
  }

  /** The instance key a message carries: `keyed by`, else its own business key. */
  private keyOf(message: Message, keyedBy: string | undefined): string | undefined {
    const path = keyedBy ?? this.businessKeyOf(message.envelope.type);
    if (path === undefined) return undefined;

    const value = path.split(".").reduce<JsonValue | undefined>(
      (acc, segment) =>
        acc !== null && acc !== undefined && typeof acc === "object" && !Array.isArray(acc)
          ? (acc as Record<string, JsonValue>)[segment]
          : undefined,
      message.body as JsonValue,
    );
    return value === undefined ? undefined : String(value);
  }

  private businessKeyOf(type: string): string | undefined {
    for (const decl of this.host.model.decls) {
      if (decl.kind !== "message" || qualify(decl.id) !== type) continue;
      return decl.fields.find((f) => f.role === "businessKey")?.name;
    }
    return undefined;
  }

  // ---- stepping -------------------------------------------------------------

  private enterStep(instance: Instance): void {
    const step = instance.saga.steps[instance.stepIndex];
    if (step === undefined) {
      this.terminate(instance, "complete");
      return;
    }

    if (step.send !== undefined) this.sendStep(instance, step);

    // Timers are keyed and cancellable: a step completing early cancels its own, or a
    // phantom firing arrives later (`04-process.md` section 2.1).
    if (step.timeout !== undefined) {
      const timeout = step.timeout;
      const index = instance.stepIndex;
      instance.stepTimer = this.host.timer(this.host.now() + timeout.afterMs, () => {
        if (instance.status !== "running" || instance.stepIndex !== index) return;
        this.trace(instance, "saga-timeout", { detail: `${step.name} after ${timeout.afterMs}ms` });
        this.act(instance, step, timeout.action, undefined);
      });
    } else if (instance.saga.deadlineMs === undefined) {
      // Neither a step timeout nor a deadline: nothing will ever end this wait, which is
      // exactly what `expect no stuck saga` is asking about.
      instance.unbounded = true;
    }
  }

  private sendStep(instance: Instance, step: StepIr): void {
    if (step.send !== undefined) this.dispatch(instance, step.send, `step ${step.name}`);
  }

  /**
   * Sends one of the saga's messages, filling its body from the instance.
   *
   * Three sources in order of authority. What the `send` block says wins, because the
   * author said it. Then the message's own `@role(businessKey)` field takes the instance
   * key — which is what makes the eventual reply correlate back — and any other field
   * takes a state field of the same name. Whatever is still missing is generated, and the
   * runtime says which, because a quietly invented payment amount is worse than a noisy
   * one.
   */
  private dispatch(instance: Instance, send: SendIr, why: string): void {
    const service = this.hosts.get(qualify(instance.saga.id));
    if (service === undefined) return;

    const decl = this.host.model.declFor(send.message);
    if (decl === undefined || decl.kind !== "message") return;
    const message = decl;

    const written: Record<string, JsonValue> = {};

    // What the author wrote.
    for (const assign of send.assigns) {
      const target = assign.target[0];
      if (target === undefined || assign.target.length > 1) continue;
      const value = this.readFor(instance, assign);
      if (value !== undefined) written[target] = value;
      else {
        this.host.note(
          `\`${qualify(instance.saga.id)}\` sends \`${qualify(message.id)}\` with ` +
            `\`${target}\` unset: ${showSource(assign)} held no value at this point`,
        );
      }
    }

    // Then what the model already says.
    for (const field of message.fields) {
      if (written[field.name] !== undefined) continue;
      if (field.role === "businessKey") {
        written[field.name] = instance.key;
        continue;
      }
      const held = instance.state[field.name];
      if (held === undefined) continue;
      const spec = fieldSpec(this.host.model, field);
      if (validate(this.host.model, spec, held).length === 0) written[field.name] = held;
    }

    const { body, generated } = this.host.fill(message, written, this.host.now());
    if (generated.length > 0) {
      this.host.note(
        `\`${qualify(instance.saga.id)}\` sends \`${qualify(message.id)}\` with ` +
          `${generated.map((g) => `\`${g}\``).join(", ")} generated: not named in the \`send\`, ` +
          "no state field of that name, and not the message's business key",
      );
    }

    // No claims. The sandbox has no credential for the hosting service — 7K declares none
    // — and forwarding the caller's would present as authority something that is audit
    // data. So the saga models no identity, and a `requires` is not evaluated for it,
    // which is the same rule any unidentified sender gets (D69).
    const sent = this.host.send(service, message, body, instance.envelope, {});
    if (sent === undefined) {
      this.host.note(
        `\`${service.id.name}\` declares no \`emits ${qualify(message.id)}\`, so \`${why}\` of ` +
          `\`${qualify(instance.saga.id)}\` has no pipe to send on`,
      );
    }
  }

  /** Applies an `on` clause's action. */
  private act(instance: Instance, step: StepIr, action: SagaAction, message: Message | undefined): void {
    this.host.cancel(instance.stepTimer);
    instance.stepTimer = undefined;

    switch (action.a) {
      case "continue":
        if (message !== undefined) this.assign(instance, action.assigns, message);
        // The step succeeded, so it becomes reversible.
        instance.completed.push(step.name);
        instance.stepIndex++;
        this.enterStep(instance);
        return;

      case "reject":
        this.terminate(instance, "reject", action.reason);
        return;

      case "abandon":
        // `abandon` takes no reason in the grammar; the step that abandoned is the reason.
        this.terminate(instance, "abandon", `abandoned in ${step.name}`);
        return;
    }
  }

  /** State is assigned only from a received message, never computed (D16). */
  private assign(instance: Instance, assigns: readonly AssignIr[], message: Message): void {
    for (const a of assigns) {
      const value = this.sourceOf(a, message);
      const [head, ...rest] = a.target;
      if (head === undefined) continue;

      if (rest.length === 0) {
        if (value === undefined) delete instance.state[head];
        else instance.state[head] = value;
        continue;
      }

      // A nested target, which the grammar permits even though the examples do not use it.
      let cursor = instance.state[head];
      if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
        cursor = {};
        instance.state[head] = cursor;
      }
      let object = cursor as Record<string, JsonValue>;
      for (const segment of rest.slice(0, -1)) {
        const next = object[segment];
        if (next === null || typeof next !== "object" || Array.isArray(next)) object[segment] = {};
        object = object[segment] as Record<string, JsonValue>;
      }
      const last = rest.at(-1)!;
      if (value === undefined) delete object[last];
      else object[last] = value;
    }
  }

  /**
   * Reads a send's source against the instance.
   *
   * There is no message in hand, so `state` and a literal are what a saga can read.
   * `occurrence` belongs to a schedule, and `message`, `envelope` and `claim` to an `on`
   * action — naming one here is a model error the checker should catch, and until it does
   * the runtime leaves the field unset and says so rather than inventing a reading.
   */
  private readFor(instance: Instance, a: AssignIr): JsonValue | undefined {
    const source = a.source;
    if (source.from === "absent") return undefined;
    if (source.from === "literal") return source.value;
    if (source.from === "envelope") {
      return readPath(instance.envelope as JsonValue, source.path);
    }

    // The terminal that ended the saga. Only a terminal `send` has one, and reading it
    // from a step's send yields nothing — a model error the checker should catch.
    if (source.from === "terminal") {
      if (instance.status === "running") return undefined;
      if (source.path[0] === "state") return instance.status;
      if (source.path[0] === "reason") return instance.reason;
      return undefined;
    }

    // A bare path in a `send` block reads the instance, which is the only thing in hand.
    if (source.from !== "state" && source.from !== "path") return undefined;

    return source.path.reduce<JsonValue | undefined>(
      (acc, segment) =>
        acc !== null && acc !== undefined && typeof acc === "object" && !Array.isArray(acc)
          ? (acc as Record<string, JsonValue>)[segment]
          : undefined,
      instance.state as JsonValue,
    );
  }

  private sourceOf(a: AssignIr, message: Message): JsonValue | undefined {
    const source = a.source;
    if (source.from === "absent") return undefined;
    if (source.from === "literal") return source.value;

    const root: JsonValue =
      source.from === "message"
        ? (message.body as JsonValue)
        : source.from === "envelope"
          ? (message.envelope.fields as JsonValue)
          : (message.claims as JsonValue);

    return source.path.reduce<JsonValue | undefined>(
      (acc, segment) =>
        acc !== null && acc !== undefined && typeof acc === "object" && !Array.isArray(acc)
          ? (acc as Record<string, JsonValue>)[segment]
          : undefined,
      root,
    );
  }

  // ---- terminating ----------------------------------------------------------

  /**
   * Unwinds the completed steps, then sends the terminal message.
   *
   * In reverse order, and only for steps that completed: a step that never succeeded has
   * nothing to reverse. That asymmetry is the property a saga test exists to check, so it
   * is implemented here and nowhere else.
   */
  private terminate(instance: Instance, terminal: Terminal, reason?: string): void {
    if (instance.status !== "running") return;

    this.host.cancel(instance.stepTimer);
    this.host.cancel(instance.deadlineTimer);
    instance.stepTimer = undefined;
    instance.deadlineTimer = undefined;
    instance.status = terminal;
    instance.endedAt = this.host.now();
    instance.unbounded = false;
    if (reason !== undefined) instance.reason = reason;

    // The terminal is announced before the unwinding, because that is the causality: it
    // rejected, and *therefore* it compensated.
    this.trace(instance, terminal === "complete" ? "saga-completed" : `saga-${terminal}ed`, {
      ...(reason === undefined ? {} : { detail: reason }),
    });

    if (terminal !== "complete") this.unwind(instance);

    // The status and reason are already set above, so a terminal `send` reading
    // `terminal.reason` sees the reason that ended this instance.
    const terminalSend = instance.saga.terminals.find((t) => t.on === terminal);
    if (terminalSend !== undefined) this.dispatch(instance, terminalSend.send, `on ${terminal}`);
  }

  private unwind(instance: Instance): void {
    for (const name of [...instance.completed].reverse()) {
      const step = instance.saga.steps.find((s) => s.name === name);
      if (step === undefined) continue;

      // `undo none` is a deliberate statement that the step cannot be reversed; an
      // absent clause is `uncompensated`, which the checker reports.
      if (step.undo === null) {
        this.trace(instance, "saga-irreversible", { detail: name });
        continue;
      }
      if (step.undo === undefined) continue;

      const message = this.host.model.declFor(step.undo.message);
      if (message?.kind !== "message") continue;
      this.trace(instance, "saga-compensating", { message: qualify(message.id), detail: name });
      this.dispatch(instance, step.undo, `undo of ${name}`);
    }
  }

  // ---- reporting ------------------------------------------------------------

  /**
   * What `.state` compares against: the step the instance is waiting in, or the terminal
   * state it reached. Both are names the model already declares, so an assertion needs no
   * vocabulary of its own.
   */
  stateOf(instance: Instance): string {
    if (instance.status !== "running") return instance.status;
    return instance.saga.steps[instance.stepIndex]?.name ?? "running";
  }

  /**
   * An instance nothing will ever finish: waiting with neither a step timeout nor a
   * deadline, or still running past a deadline that should have abandoned it.
   */
  stuck(instance: Instance): boolean {
    if (instance.status !== "running") return false;
    if (instance.unbounded) return true;
    const deadline = instance.saga.deadlineMs;
    return deadline !== undefined && this.host.now() > instance.startedAt + deadline;
  }

  private trace(instance: Instance, kind: string, extra: Partial<TraceEvent> = {}): void {
    this.host.record({
      at: this.host.now(),
      iso: new Date(this.host.now()).toISOString(),
      kind: kind as TraceEvent["kind"],
      saga: qualify(instance.saga.id),
      sagaKey: instance.key,
      ...extra,
    });
  }
}
