/**
 * The engine: pipes, subscriptions, delivery and handler invocation.
 *
 * Three decisions shape everything here.
 *
 * **The delivery guarantee decides what happens on failure.** `at-least-once`
 * retries under the subscription's policy and dead-letters when it is exhausted;
 * `at-most-once` simply loses the message, because there is nowhere for it to go.
 * That is the semantic difference that always applies, and it is what makes a
 * declared guarantee more than documentation.
 *
 * **A handler that does not answer has not acknowledged.** A broker redelivers an
 * unacknowledged message once its visibility window lapses, and the sandbox has to
 * model that or `hang` would be indistinguishable from success. 7K declares no such
 * window — it is a broker's concern, not a contract's — so the sandbox supplies one
 * and names it (`ackTimeoutMs`, five virtual seconds by default). Nothing in the
 * language depends on the number; everything about redelivery does.
 *
 * **Spontaneous faults are opt-in.** The sandbox should be hostile in proportion to
 * the declared guarantee, but a broker that duplicated on a whim would make every
 * `count 1` assertion meaningless. So duplication arises where it really arises —
 * from redelivery, and from a handler that replies and *then* fails — while
 * whimsical loss and reordering live behind `chaos`, seeded so they stay
 * reproducible.
 */

import {
  effectiveMocks,
  qualify,
  RETRY_DEFAULT,
  symbolKey,
  type JsonValue,
  type LinkedModel,
  type MessageIr,
  type Mock,
  type MockRule,
  type Outcome,
  type PipeIr,
  type ReactIr,
  type Ref,
  type Scenario,
  type ScenarioFile,
  type ServiceIr,
} from "@sevenk/core";
import { Clock, EventQueue, Rng, type ScheduledEvent, type VirtualTime } from "./clock.js";
import { evaluate, type Claims, type Message } from "./message.js";
import {
  fieldSpec,
  generate,
  normalizeValue,
  prepareBody,
  prepareEnvelope,
  specOfDecl,
  validate,
  type Problem,
} from "./schema.js";
import { Sagas, type Instance } from "./saga.js";
import { Schedules } from "./schedule.js";
import { Trace, type TraceEvent, type TraceReason } from "./trace.js";

/**
 * A live handler. It receives what a generated wrapper would hand it — a validated,
 * normalized, deduplicated message — and returns one of its declared replies, or
 * nothing.
 *
 * Deliberately the same shape a production wrapper calls, so a handler cannot tell
 * which transport delivered the message. A test that ran it through a different path
 * would not be testing the handler you deploy.
 */
export type Handler = (message: Message) => Promise<HandlerResult | void> | HandlerResult | void;

export interface HandlerResult {
  /** The reply to emit. Must be inside the subscription's declared outcome space. */
  readonly reply?: string;
  readonly body?: Readonly<Record<string, JsonValue>>;
}

export interface EngineOptions {
  readonly seed?: number;
  readonly start?: VirtualTime;
  /** Spontaneous loss and reordering, within what each pipe's guarantee permits. */
  readonly chaos?: boolean;
  /** Services to run for real, by declared name. Everything else is mocked. */
  readonly live?: ReadonlyMap<string, Handler>;
  /** How long an unacknowledged delivery waits before it is redelivered. */
  readonly ackTimeoutMs?: number;
  /** Run the Process layer: sagas and schedules. On by default. */
  readonly process?: boolean;
}

// ---- internal state ---------------------------------------------------------

interface Subscription {
  readonly service: ServiceIr;
  readonly react: ReactIr;
  readonly name: string;
  readonly pipe: PipeIr;
  /** True when the subscription declares a reply, so silence is a fault. */
  readonly owesReply: boolean;
  /** Deduplication keys already handled. Permanent, unlike a broker's window (D55). */
  readonly seen: Set<string>;
  /** Advances per call, for a `sequence` mock. */
  readonly sequencePosition: Map<string, number>;
}

interface Delivery {
  readonly message: Message;
  readonly pipe: PipeIr;
  readonly subscription: Subscription;
  readonly attempt: number;
  /** Set once handled, failed or lost, so a late acknowledgement deadline is inert. */
  settled?: boolean;
}

type Event =
  | { readonly e: "deliver"; readonly delivery: Delivery }
  | { readonly e: "timeout"; readonly delivery: Delivery }
  | { readonly e: "emit"; readonly message: Message; readonly pipe: PipeIr }
  /**
   * Deferred work for the Process layer: a step timeout, a saga deadline, a schedule
   * firing. `recurring` marks the ones that generate new work forever, so settling a run
   * can finish what is in flight without inventing a year of schedule occurrences.
   */
  | { readonly e: "timer"; readonly run: () => void; readonly recurring?: boolean };

const ACK_TIMEOUT_DEFAULT = 5_000;

/**
 * The delay before a given attempt, from the subscription's declared policy.
 *
 * Read from the IR rather than re-parsed from source text: the policy is lowered in
 * Core, so this runtime and the checker cannot disagree about what `retry 5 after 2s
 * max 30s` means.
 */
function backoffFor(react: ReactIr, attempt: number): number {
  const policy = react.retry ?? RETRY_DEFAULT;
  const raw =
    policy.backoff === "linear" ? policy.delayMs : policy.delayMs * 2 ** (attempt - 1);
  return policy.maxMs === undefined ? raw : Math.min(raw, policy.maxMs);
}

/** `retry 0` means deliver once, so the attempt budget is always one more than that. */
const attemptsFor = (react: ReactIr): number => (react.retry ?? RETRY_DEFAULT).retries + 1;

export class Engine {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly trace = new Trace();
  /** Things only running the model reveals, and things the sandbox cannot yet run. */
  readonly notes: string[] = [];

  private readonly queue = new EventQueue<Event>();
  private readonly subscriptions: Subscription[] = [];
  private readonly messages = new Map<string, MessageIr>();
  private readonly mocks: Map<string, Mock>;
  private readonly live: ReadonlyMap<string, Handler>;
  private readonly chaos: boolean;
  private readonly ackTimeoutMs: number;
  /** Packages the scenario can name: its own and its imports. */
  private readonly visible: ReadonlySet<string>;
  private readonly sagas?: Sagas;
  private readonly schedules?: Schedules;

  constructor(
    readonly model: LinkedModel,
    private readonly scenarioFile: ScenarioFile,
    scenario: Scenario,
    options: EngineOptions = {},
  ) {
    this.clock = new Clock(options.start === undefined ? {} : { start: options.start });
    this.rng = new Rng(options.seed ?? scenario.seed ?? 0);
    this.chaos = options.chaos ?? false;
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_DEFAULT;
    this.live = options.live ?? new Map();
    this.mocks = effectiveMocks(scenarioFile, scenario);

    // The Process layer runs only for what the scenario can see: its own package and the
    // ones it imports. A saga or a schedule in an unrelated package is not part of the
    // system under test, and a nightly job three packages away should not be driving the
    // clock of a scenario about a retry policy.
    this.visible = new Set<string>([
      scenarioFile.package,
      ...(this.model.packages.get(scenarioFile.package)?.imports ?? []).map((i) => i.target),
    ]);

    this.index();

    // The Process layer runs on the same queue and the same clock as everything else, so
    // a saga's deadline and a message's retry are ordered against each other rather than
    // living in separate worlds.
    if (options.process !== false) {
      this.sagas = new Sagas(this.host(false));
      this.schedules = new Schedules(this.host(true));
      this.schedules.start();
    }
  }

  /**
   * What the Process layer is given. Narrow on purpose: a saga may send, wait and record,
   * and nothing else. It cannot reach into a subscription or a mock.
   */
  private host(recurring: boolean) {
    return {
      model: this.model,
      inScope: (pkg: string) => this.visible.has(pkg),
      now: () => this.clock.now(),
      record: (event: Omit<TraceEvent, "seq">) => this.trace.record(event),
      // `recurring` is true for a schedule, whose chain never ends. Settling a run
      // finishes what is in flight without inventing a year of occurrences.
      timer: (at: VirtualTime, run: () => void) =>
        this.queue.schedule(at, { e: "timer", run, recurring }),
      cancel: (timer: ScheduledEvent<unknown> | undefined) => {
        if (timer !== undefined) (timer as { cancelled?: boolean }).cancelled = true;
      },
      send: (
        from: ServiceIr,
        message: MessageIr,
        body: Readonly<Record<string, JsonValue>>,
        envelope: Readonly<Record<string, JsonValue>>,
        claims: Claims,
      ) => this.sendFrom(from, message, body, envelope, claims),
      fill: (message: MessageIr, written: Readonly<Record<string, JsonValue>>, at: VirtualTime) =>
        this.fillBody(message, written, at),
      note: (text: string) => {
        this.notes.push(text);
      },
    };
  }

  /** Live saga instances, for a scenario's `expect saga` and for a graph view. */
  get instances(): readonly Instance[] {
    return this.sagas?.all ?? [];
  }

  get sagaRuntime(): Sagas | undefined {
    return this.sagas;
  }

  // ---- wiring ---------------------------------------------------------------

  private index(): void {
    const perPipe = new Map<string, { count: number; pipe: PipeIr }>();

    for (const decl of this.model.decls) {
      if (decl.kind === "message") {
        this.messages.set(qualify(decl.id), decl);
        continue;
      }
      // An @external service is a contract, not a participant: nothing is generated
      // for it, so the sandbox hosts no subscription on its behalf either.
      if (decl.kind !== "service" || decl.external) continue;

      for (const react of decl.reacts) {
        const pipe = this.model.declFor(react.pipe);
        if (pipe === undefined || pipe.kind !== "pipe") continue;

        this.subscriptions.push({
          service: decl,
          react,
          name: react.subscription,
          pipe,
          owesReply: (react.replies ?? []).some((r) => r !== "none"),
          seen: new Set(),
          sequencePosition: new Map(),
        });

        const resolved = this.model.resolve(react.message);
        const key = `${qualify(pipe.id)}\u0000${resolved === undefined ? react.message.text : qualify(resolved)}`;
        perPipe.set(key, { count: (perPipe.get(key)?.count ?? 0) + 1, pipe });
      }
    }

    // On a queue a message is consumed once, so two subscriptions to the same message
    // compete for it rather than each getting a copy. Rarely what an author intends,
    // and `03-topology.md` section 2.6 flags it as a hazard.
    for (const [key, { count, pipe }] of perPipe) {
      if (count > 1 && pipe.pipeKind === "queue") {
        this.notes.push(
          `\`${qualify(pipe.id)}\` is a queue with ${count} subscriptions to ` +
            `\`${key.split("\u0000")[1]}\`, which compete for each message rather than each ` +
            "receiving a copy",
        );
      }
    }
  }

  private subscriptionsFor(pipe: PipeIr): Subscription[] {
    return this.subscriptions.filter(
      (s) => s.pipe.id.name === pipe.id.name && s.pipe.id.pkg === pipe.id.pkg,
    );
  }

  private at(extra: Partial<TraceEvent> = {}): Omit<TraceEvent, "seq" | "kind"> {
    return { at: this.clock.now(), iso: this.clock.iso(), ...extra };
  }

  private where(d: Delivery): Omit<TraceEvent, "seq" | "kind"> {
    return this.at({
      message: d.message.envelope.type,
      pipe: qualify(d.pipe.id),
      service: d.subscription.service.id.name,
      subscription: d.subscription.name,
      id: d.message.envelope.id,
    });
  }

  // ---- publishing -----------------------------------------------------------

  /**
   * Puts a message on a pipe as a producer would.
   *
   * `checked` is the composer's own validation. A scenario writes `unchecked` to skip
   * it, which is the only way to get a contract-violating payload onto a pipe, and so
   * the only way to test a consumer's rejection path at all.
   */
  publish(
    message: MessageIr,
    pipe: PipeIr,
    written: Readonly<Record<string, JsonValue>>,
    options: {
      readonly from?: string;
      readonly claims?: Claims;
      readonly envelope?: Readonly<Record<string, JsonValue>>;
      readonly checked?: boolean;
    } = {},
  ): { readonly message: Message; readonly problems: readonly Problem[] } {
    const now = this.clock.now();
    const { body, problems } = prepareBody(this.model, message, written, this.rng, now);
    const envelope = prepareEnvelope(this.model, message, options.envelope ?? {}, this.rng, now);

    const sent: Message = {
      envelope: {
        id: this.rng.uuid(),
        type: qualify(message.id),
        ...(message.version === undefined ? {} : { version: message.version }),
        time: now,
        fields: envelope,
      },
      body,
      from: options.from ?? "scenario",
      claims: options.claims ?? {},
    };

    // The composer refuses an invalid payload unless told not to, so a typo in a
    // fixture is reported where it was written rather than surfacing as a dead-letter
    // three hops away.
    if (options.checked !== false && problems.length > 0) return { message: sent, problems };

    this.trace.record({
      ...this.at({
        message: sent.envelope.type,
        pipe: qualify(pipe.id),
        service: sent.from,
        id: sent.envelope.id,
        envelope: sent.envelope.fields,
        body: sent.body,
        ...(Object.keys(sent.claims).length === 0 ? {} : { claims: sent.claims }),
      }),
      kind: "published",
    });

    this.route(sent, pipe);
    return { message: sent, problems: [] };
  }

  /**
   * Sends a message on a service's own `emits` route.
   *
   * This is how the Process layer puts anything on a pipe: a step's `send`, a
   * compensation, a terminal event, a schedule's occurrence. Routing comes from the
   * hosting service's `emits` table and nowhere else, which is why a service's `emits`
   * list includes messages its handlers never personally send (`04-process.md` 1.5).
   */
  private sendFrom(
    from: ServiceIr,
    message: MessageIr,
    body: Readonly<Record<string, JsonValue>>,
    envelope: Readonly<Record<string, JsonValue>>,
    claims: Claims,
  ): string | undefined {
    const emit = from.emits.find((e) => {
      const id = this.model.resolve(e.message);
      return id !== undefined && qualify(id) === qualify(message.id);
    });
    if (emit === undefined) return undefined;

    const pipe = this.model.declFor(emit.pipe);
    if (pipe === undefined || pipe.kind !== "pipe") return undefined;

    const now = this.clock.now();
    const sent: Message = {
      envelope: {
        id: this.rng.uuid(),
        type: qualify(message.id),
        ...(message.version === undefined ? {} : { version: message.version }),
        time: now,
        // The saga's envelope travels forward, so a refund is traceable to the order that
        // caused it (`04-process.md` 1.4).
        fields: prepareEnvelope(this.model, message, envelope, this.rng, now),
      },
      body,
      from: from.id.name,
      // A saga acts under the hosting service's identity; the original subject rides as
      // envelope data rather than as a credential (`04-process.md` 1.8).
      claims,
    };

    this.trace.record({
      ...this.at({
        message: sent.envelope.type,
        pipe: qualify(pipe.id),
        service: sent.from,
        id: sent.envelope.id,
        envelope: sent.envelope.fields,
        body: sent.body,
      }),
      kind: "published",
    });

    this.route(sent, pipe);
    return sent.envelope.id;
  }

  /**
   * Fills a partial body, reporting which fields had to be invented.
   *
   * The Process layer has no syntax for a `send` payload, so a saga's command is built
   * from what the instance holds. Saying which fields were generated is the honest half:
   * a quietly fabricated payment amount is worse than a noisy one.
   */
  private fillBody(
    message: MessageIr,
    written: Readonly<Record<string, JsonValue>>,
    at: VirtualTime,
  ): { body: Record<string, JsonValue>; generated: readonly string[] } {
    const spec = specOfDecl(this.model, message, [], 0);
    const body: Record<string, JsonValue> = { ...written };
    const generated: string[] = [];

    for (const field of spec.fields ?? []) {
      if (body[field.name] !== undefined || field.optional) continue;
      body[field.name] = generate(this.model, fieldSpec(this.model, field), this.rng, at);
      generated.push(field.name);
    }

    return { body: normalizeValue(this.model, spec, body) as Record<string, JsonValue>, generated };
  }

  /** Puts a message in front of the subscriptions a pipe's kind says should see it. */
  private route(message: Message, pipe: PipeIr): void {
    const eligible = this.subscriptionsFor(pipe).filter((s) => {
      const target = this.model.resolve(s.react.message);
      return target === undefined
        ? s.react.message.text === message.envelope.type
        : qualify(target) === message.envelope.type;
    });

    const interested = eligible.filter((s) => this.interested(s, message, pipe));
    if (interested.length === 0) return;

    // A queue is point-to-point: exactly one consumer handles each message. A topic
    // and a stream fan out, so each subscription receives its own copy.
    const targets =
      pipe.pipeKind === "queue" && interested.length > 1 ? [this.rng.pick(interested)!] : interested;

    for (const subscription of targets) {
      this.enqueue({ message, pipe, subscription, attempt: 1 }, 0);
    }
  }

  /**
   * Whether a subscription wants this message at all.
   *
   * A miss is silence: never retried, never dead-lettered (D56). The broker filtered
   * it, so as far as the consumer is concerned it was never sent.
   */
  private interested(s: Subscription, message: Message, pipe: PipeIr): boolean {
    const skip = (reason: TraceReason, detail: string): false => {
      this.trace.record({
        ...this.at({
          message: message.envelope.type,
          pipe: qualify(pipe.id),
          service: s.service.id.name,
          subscription: s.name,
          id: message.envelope.id,
          reason,
          detail,
        }),
        kind: "filtered",
      });
      return false;
    };

    // `accepts v1.0` pins a subscription to a version, so a later one is not
    // delivered rather than delivered and misread.
    if (
      s.react.accepts !== undefined &&
      message.envelope.version !== undefined &&
      !versionAccepted(s.react.accepts, message.envelope.version)
    ) {
      return skip("version", `accepts ${s.react.accepts}, message is v${message.envelope.version}`);
    }

    if (s.react.where !== undefined && !evaluate(s.react.where, message)) {
      return skip("filtered", "where");
    }

    return true;
  }

  private enqueue(delivery: Delivery, delayMs: number): void {
    // Reordering is a chaos behaviour, not a default: a broker that shuffled on a
    // whim would make an ordering assertion untestable rather than hostile.
    const jitter = this.chaos && delivery.pipe.orderingBy === undefined ? this.rng.int(5) : 0;
    this.queue.schedule(this.clock.now() + delayMs + jitter, { e: "deliver", delivery });
  }

  // ---- delivery -------------------------------------------------------------

  private async deliver(delivery: Delivery): Promise<void> {
    const { message, pipe, subscription, attempt } = delivery;

    // An at-most-once pipe may lose a message outright. Only under chaos: that is the
    // whole meaning of the guarantee, but a scenario should opt into it rather than
    // have its assertions quietly undermined.
    if (this.chaos && pipe.delivery === "at-most-once" && this.rng.chance(20)) {
      delivery.settled = true;
      this.trace.record({
        ...this.where(delivery),
        kind: "dropped",
        reason: "lossy",
        detail: "at-most-once",
      });
      return;
    }

    // Deduplication, before the handler.
    const key = this.dedupeKey(subscription, message);
    if (key !== undefined && subscription.seen.has(key)) {
      delivery.settled = true;
      this.trace.record({
        ...this.where(delivery),
        kind: "deduplicated",
        reason: "duplicate",
        detail: key,
      });
      return;
    }

    // Authorization, before the handler. A failed claim check is a rejection, never
    // retried: a second attempt with the same claims cannot succeed (D34).
    //
    // Evaluated only when the sender supplied claims. A scenario that models no
    // identity is not testing authorization, and making every fixture carry a full
    // claim set to get past `requires` would be noise in every scenario that is about
    // something else.
    if (
      subscription.react.requires !== undefined &&
      Object.keys(message.claims).length > 0 &&
      !evaluate(subscription.react.requires, message)
    ) {
      delivery.settled = true;
      this.trace.record({ ...this.where(delivery), kind: "rejected", reason: "unauthorized" });
      this.deadLetter(delivery, "unauthorized", "unauthorized");
      return;
    }

    // Validation on receipt, after normalization — where generated code does it
    // (`docs/spec/01-kernel.md` section 3). Also never retried: the payload will not
    // improve on a second attempt.
    const invalid = this.invalidities(message);
    if (invalid.length > 0) {
      delivery.settled = true;
      this.trace.record({
        ...this.where(delivery),
        kind: "rejected",
        reason: "invalid",
        detail: invalid.map((p) => `${p.path}: ${p.message}`).join("; "),
      });
      this.deadLetter(delivery, "invalid", "invalid payload");
      return;
    }

    this.trace.record({ ...this.where(delivery), kind: "delivered", attempt });
    if (key !== undefined) subscription.seen.add(key);

    const handler = this.live.get(subscription.service.id.name);
    if (handler !== undefined) {
      await this.runLive(delivery, handler);
      return;
    }

    const outcome = this.mockOutcome(subscription, message);

    if (outcome.o === "hang") {
      // Nothing is scheduled but the acknowledgement deadline, so the broker will
      // redeliver. That is the defect the scenario is hunting.
      this.queue.schedule(this.clock.now() + this.ackTimeoutMs, { e: "timeout", delivery });
      return;
    }

    if (outcome.o === "fail") {
      this.failed(delivery, "failed", "mock: fail");
      return;
    }

    delivery.settled = true;
    this.trace.record({ ...this.where(delivery), kind: "handled" });
    this.emitReply(subscription, message, outcome.message, outcome.payload, outcome.afterMs);
    this.observed(subscription, message);

    // `reply X then fail`: the reply is observable *and* the message is redelivered,
    // which is how at-least-once duplication gets exercised against a dedup key.
    if (outcome.thenFail) {
      delivery.settled = false;
      this.failed(delivery, "failed", "mock: reply then fail");
    }
  }

  /**
   * A message reached the end of its life at a service.
   *
   * A saga observes its hosting service rather than subscribing in its own right, so this
   * is the one door into the Process layer. A schedule learns from the same place that its
   * occurrence is over and the next may run.
   */
  private observed(subscription: Subscription, message: Message): void {
    this.sagas?.observe(subscription.service, message);
    this.schedules?.settled(message.envelope.id);
  }

  private async runLive(delivery: Delivery, handler: Handler): Promise<void> {
    const { subscription, message } = delivery;
    try {
      const result = (await handler(message)) ?? {};
      delivery.settled = true;
      this.trace.record({ ...this.where(delivery), kind: "handled" });
      if (result.reply !== undefined) {
        this.emitReply(subscription, message, result.reply, result.body, 0);
      }
      this.observed(subscription, message);
    } catch (error) {
      // The cause is outside the model, so the engine records only that it failed
      // (D26): "the gateway timed out" and "the database deadlocked" are the same
      // observable to everything downstream.
      this.failed(delivery, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Every way a body fails its own contract, as a consumer would find them. */
  private invalidities(message: Message): readonly Problem[] {
    const decl = this.messages.get(message.envelope.type);
    if (decl === undefined) return [];
    // By the declaration, not by a synthesized reference: resolution is keyed on
    // reference identity, so a `Ref` the linker never saw resolves to nothing and the
    // body would silently validate against an unknown type.
    return validate(this.model, specOfDecl(this.model, decl, [], 0), message.body as JsonValue);
  }

  // ---- replies --------------------------------------------------------------

  private emitReply(
    subscription: Subscription,
    inbound: Message,
    replyName: string | undefined,
    payload: JsonValue | undefined,
    afterMs: number,
  ): void {
    if (replyName === undefined) return; // `reply none`: correctly silent

    const target =
      this.model.lookup(this.scenarioFile.package, replyName) ??
      this.model.lookup(subscription.service.id.pkg, replyName);
    const emit = subscription.service.emits.find((e) => {
      const id = this.model.resolve(e.message);
      if (id === undefined || target === undefined) return e.message.text === replyName;
      return symbolKey(id.pkg, id.name) === symbolKey(target.id.pkg, target.id.name);
    });

    if (emit === undefined || target === undefined || target.kind !== "message") {
      this.notes.push(
        `\`${subscription.service.id.name}\` replied \`${replyName}\`, which it declares no ` +
          "`emits` clause for, so there is no pipe to put it on",
      );
      return;
    }

    const pipe = this.model.declFor(emit.pipe);
    if (pipe === undefined || pipe.kind !== "pipe") return;

    const at = this.clock.now() + afterMs;
    const written = (payload ?? {}) as Record<string, JsonValue>;

    // A mock's payload is partial: an unspecified required field is carried from the
    // request when the names match, and generated otherwise. That keeps a mock about
    // the one field it is testing without breaking the correlation a real handler
    // would preserve.
    const { body, problems } = prepareBody(this.model, target, written, this.rng, at, inbound.body);
    if (problems.length > 0) {
      this.notes.push(
        `the mocked reply \`${replyName}\` is not valid against its own contract: ` +
          problems.map((p) => `${p.path}: ${p.message}`).join("; "),
      );
    }

    const envelope = prepareEnvelope(this.model, target, {}, this.rng, at, {
      id: inbound.envelope.id,
      fields: inbound.envelope.fields,
    });

    this.queue.schedule(at, {
      e: "emit",
      message: {
        envelope: {
          id: this.rng.uuid(),
          type: qualify(target.id),
          ...(target.version === undefined ? {} : { version: target.version }),
          time: at,
          fields: envelope,
        },
        body,
        from: subscription.service.id.name,
        // Identity travels with the conversation, so a downstream `requires` sees the
        // same subject the originator presented.
        claims: inbound.claims,
      },
      pipe,
    });
  }

  // ---- failure --------------------------------------------------------------

  private failed(delivery: Delivery, reason: TraceReason, detail: string): void {
    if (delivery.settled === true) return;
    delivery.settled = true;

    const { pipe, subscription, attempt } = delivery;
    this.trace.record({ ...this.where(delivery), kind: "failed", attempt, reason, detail });

    // An at-most-once pipe has nowhere to put a failure, which is the guarantee doing
    // exactly what it says on the tin.
    if (pipe.delivery === "at-most-once") {
      this.trace.record({
        ...this.where(delivery),
        kind: "dropped",
        reason: "lossy",
        detail: "at-most-once: no redelivery",
      });
      return;
    }

    if (attempt >= attemptsFor(subscription.react)) {
      this.deadLetter(delivery, "exhausted", `${detail} after ${attempt} attempts`);
      return;
    }

    const delay = backoffFor(subscription.react, attempt);

    this.trace.record({
      ...this.where(delivery),
      kind: "retrying",
      attempt: attempt + 1,
      detail: `in ${delay}ms`,
    });

    // The deduplication key from the failed attempt is released: it was never
    // successfully handled, so a redelivery must reach the handler again.
    const key = this.dedupeKey(subscription, delivery.message);
    if (key !== undefined) subscription.seen.delete(key);

    this.enqueue({ message: delivery.message, pipe, subscription, attempt: attempt + 1 }, delay);
  }

  private deadLetter(delivery: Delivery, reason: TraceReason, detail: string): void {
    const { pipe } = delivery;

    // `dlq none` means there is nothing to dead-letter into, so the message is lost.
    // Recording a dead-letter to a pipe that does not exist would be a fiction.
    if (pipe.dlq === null) {
      this.trace.record({
        ...this.where(delivery),
        kind: "dropped",
        reason: "discarded",
        detail: `dlq none: ${detail}`,
      });
      return;
    }

    const declared = pipe.dlq === undefined ? undefined : this.model.declFor(pipe.dlq);
    const target =
      declared !== undefined && declared.kind === "pipe"
        ? qualify(declared.id)
        : `${qualify(pipe.id)}.dead`;

    this.trace.record({
      ...this.where(delivery),
      kind: "dead-lettered",
      pipe: target,
      reason,
      detail,
    });
    // An occurrence that dead-letters is over as surely as one that succeeded, so the
    // schedule is free to run the next.
    this.schedules?.settled(delivery.message.envelope.id);
  }

  /**
   * The deduplication key: `once per <path>`, else the message's
   * `@role(businessKey)` field. `once per none` is a claim of natural idempotence, so
   * there is no key and no store (D65).
   */
  private dedupeKey(subscription: Subscription, message: Message): string | undefined {
    const dedupe = subscription.react.dedupe;
    if (dedupe !== undefined && "none" in dedupe) return undefined;

    const path =
      dedupe !== undefined && "by" in dedupe ? dedupe.by : this.businessKeyField(message);
    if (path === undefined) return undefined;

    const value = path.split(".").reduce<JsonValue | undefined>(
      (acc, segment) =>
        acc !== null && acc !== undefined && typeof acc === "object" && !Array.isArray(acc)
          ? (acc as Record<string, JsonValue>)[segment]
          : undefined,
      message.body as JsonValue,
    );

    // No key means no deduplication: a message with no business identity has nothing
    // to be a duplicate *of*.
    return value === undefined ? undefined : `${subscription.name}:${String(value)}`;
  }

  private businessKeyField(message: Message): string | undefined {
    const decl = this.messages.get(message.envelope.type);
    return decl?.fields.find((f) => f.role === "businessKey")?.name;
  }

  // ---- mock selection -------------------------------------------------------

  private mockOutcome(subscription: Subscription, message: Message): Outcome {
    const mock = this.findMock(subscription.service);
    const rule = mock?.rules.find((r) => this.ruleMatches(r, message));

    if (rule === undefined) {
      // A subscription that declares `replies none` owes no answer, so an unscripted
      // one succeeds silently — which is most consumers, and making every scenario
      // mock them would be noise. One that owes a reply and has no script hangs,
      // because an unscripted service cannot be assumed to behave.
      if (!subscription.owesReply) return { o: "reply", afterMs: 0, thenFail: false };

      // Unless the saga is the handler. A service hosting a saga started by this message
      // is implemented by that saga, so it answers with its one declared reply — which is
      // what "the process began" means. Several alternatives and the saga cannot choose.
      const saga = this.sagas?.startsASaga(subscription.service, message.envelope.type);
      if (saga !== undefined) {
        const alternatives = (subscription.react.replies ?? []).filter((r) => r !== "none");
        if (alternatives.length === 1) {
          const only = this.model.declFor(alternatives[0] as Ref);
          if (only?.kind === "message") {
            return { o: "reply", message: qualify(only.id), afterMs: 0, thenFail: false };
          }
        }
        this.notes.push(
          `\`${subscription.service.id.name}\` starts \`${qualify(saga.id)}\` on ` +
            `\`${message.envelope.type}\` but declares ${alternatives.length} replies, so the saga ` +
            "cannot choose which to send; mock the service to say",
        );
        return { o: "hang" };
      }

      this.notes.push(
        `\`${subscription.service.id.name}\` owes a reply to \`${message.envelope.type}\` but is ` +
          "neither live nor mocked, so it never answers",
      );
      return { o: "hang" };
    }

    const selection = rule.selection;
    switch (selection.s) {
      case "always":
        return selection.outcome;

      case "conditional": {
        const chosen =
          selection.cases.find((c) => c.when !== undefined && evaluate(c.when, message)) ??
          selection.cases.find((c) => c.when === undefined);
        return chosen?.outcome ?? { o: "hang" };
      }

      case "sequence": {
        const i = subscription.sequencePosition.get(rule.message) ?? 0;
        subscription.sequencePosition.set(rule.message, i + 1);
        // Past the end the last outcome repeats: a sequence describes a recovery, not
        // a cliff.
        return selection.outcomes[Math.min(i, selection.outcomes.length - 1)] ?? { o: "hang" };
      }

      case "weighted": {
        const roll = this.rng.next() * 100;
        let acc = 0;
        for (const c of selection.cases) {
          acc += c.weight;
          if (roll < acc) return c.outcome;
        }
        return selection.cases.at(-1)?.outcome ?? { o: "hang" };
      }
    }
  }

  /** A scenario may name a service through an import alias, so compare identities. */
  private findMock(service: ServiceIr): Mock | undefined {
    for (const [name, mock] of this.mocks) {
      if (name === service.id.name) return mock;
      const decl = this.model.lookup(this.scenarioFile.package, name);
      if (decl !== undefined && decl.id.name === service.id.name && decl.id.pkg === service.id.pkg) {
        return mock;
      }
    }
    return undefined;
  }

  private ruleMatches(rule: MockRule, message: Message): boolean {
    const decl = this.model.lookup(this.scenarioFile.package, rule.message);
    if (decl !== undefined) return qualify(decl.id) === message.envelope.type;
    return (
      message.envelope.type === rule.message || message.envelope.type.endsWith(`.${rule.message}`)
    );
  }

  // ---- the loop -------------------------------------------------------------

  /** Drains everything due at the current instant. Returns how many events ran. */
  async drain(): Promise<number> {
    let worked = 0;
    for (;;) {
      const next = this.queue.peek();
      if (next === undefined || next.at > this.clock.now()) return worked;
      const event = this.queue.take();
      if (event === undefined) return worked;
      worked++;
      await this.apply(event.payload);
    }
  }

  private async apply(event: Event): Promise<void> {
    switch (event.e) {
      case "deliver":
        await this.deliver(event.delivery);
        return;

      case "timeout":
        // A delivery that answered in time cancelled nothing; the deadline simply
        // finds it settled and does nothing.
        this.failed(event.delivery, "timeout", `no acknowledgement within ${this.ackTimeoutMs}ms`);
        return;

      case "timer":
        event.run();
        return;

      case "emit":
        this.trace.record({
          ...this.at({
            message: event.message.envelope.type,
            pipe: qualify(event.pipe.id),
            service: event.message.from,
            id: event.message.envelope.id,
            envelope: event.message.envelope.fields,
            body: event.message.body,
          }),
          kind: "published",
        });
        this.route(event.message, event.pipe);
        return;
    }
  }

  /**
   * Advances the clock by `byMs`, draining at each instant something is due.
   *
   * This is the loop that makes `advance 30d` instant: between events the clock
   * teleports, because nothing is actually being waited on.
   */
  async advance(byMs: number, mark = true): Promise<void> {
    const target = this.clock.now() + byMs;
    for (;;) {
      await this.drain();
      const next = this.queue.peek();
      if (next === undefined || next.at > target) break;
      this.clock.jumpTo(next.at);
    }
    this.clock.jumpTo(target);
    await this.drain();
    // Only a deliberate `advance` marks the trace. Time also moves to reach an `at`
    // or the next tick of a soak's load, and recording those would bury an hour's run
    // under eighteen thousand clock lines.
    if (mark) this.trace.record({ ...this.at({ detail: `+${byMs}ms` }), kind: "advanced" });
  }

  /** Moves the clock to an absolute instant, never backwards. */
  async advanceTo(at: VirtualTime): Promise<void> {
    if (at > this.clock.now()) await this.advance(at - this.clock.now(), false);
    else await this.drain();
  }

  /**
   * Finishes the work already in flight, ignoring recurring timers.
   *
   * This is what a scenario wants after its last step: a dead letter one backoff away
   * should still appear, but the clock should not run on inventing schedule occurrences
   * the scenario never asked to advance through. A schedule fires because a scenario
   * advanced the clock past it, not because the run ended.
   */
  async settle(limitMs = 30 * 86_400_000): Promise<void> {
    const deadline = this.clock.now() + limitMs;
    for (;;) {
      await this.drain();
      const next = this.queue
        .pending()
        .find((e) => !(e.payload.e === "timer" && e.payload.recurring === true));
      if (next === undefined || next.at > deadline) return;
      this.clock.jumpTo(next.at);
    }
  }

  /** Runs until nothing is pending, however far away that is on the clock. */
  async runToQuiescence(limitMs = 365 * 86_400_000): Promise<void> {
    const deadline = this.clock.now() + limitMs;
    for (;;) {
      await this.drain();
      const next = this.queue.peek();
      if (next === undefined || next.at > deadline) return;
      this.clock.jumpTo(next.at);
    }
  }

  /** One event at a time — the step mode a debugger and the Spider need. */
  async step(): Promise<boolean> {
    const next = this.queue.peek();
    if (next === undefined) return false;
    if (next.at > this.clock.now()) this.clock.jumpTo(next.at);
    const event = this.queue.take();
    if (event === undefined) return false;
    await this.apply(event.payload);
    return true;
  }

  get pending(): number {
    return this.queue.size;
  }
}

/** `accepts v1.0`, `accepts 1.x`, `accepts 1.2..2.0` against a message's version. */
export function versionAccepted(accepts: string, version: string): boolean {
  const want = accepts.replace(/^v/, "").trim();
  const [major, minor] = version.split(".");

  if (want.endsWith(".x")) return want.slice(0, -2) === major;

  const span = want.split("..");
  if (span.length === 2 && span[0] !== "" && span[1] !== "") {
    const n = Number(`${major}.${minor}`);
    return n >= Number(span[0]) && n <= Number(span[1]);
  }

  return want === `${major}.${minor}` || want === major;
}
