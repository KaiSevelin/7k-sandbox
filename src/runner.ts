/**
 * Running a scenario: executing its steps, then judging it against the trace.
 *
 * Expectations are evaluated against the **recorded trace**, never against engine
 * internals. That is not a stylistic choice: the trace is a published interchange
 * artifact (`docs/spec/30-scenarios.md` section 7), so an assertion that passes here
 * is an assertion about something another runtime could also produce. An assertion
 * that reached into the engine's own state would pass only in this sandbox, and the
 * conformance suite would prove nothing.
 *
 * Counts are cumulative over the whole run (D62). Order-relative counting makes a
 * scenario's meaning depend on where its assertions happen to sit.
 */

import {
  qualify,
  type Expect,
  type JsonValue,
  type LinkedModel,
  type MessageIr,
  type PipeIr,
  type Publish,
  type Scenario,
  type ScenarioFile,
  type ServiceIr,
} from "@sevenk/core";
import { Engine, type EngineOptions, type Handler } from "./engine.js";
import type { Claims } from "./message.js";
import type { Trace, TraceEvent } from "./trace.js";

export type Status = "pass" | "fail" | "unsupported";

export interface AssertionResult {
  readonly status: Status;
  /** The assertion as written, rendered back for a report. */
  readonly text: string;
  readonly detail?: string;
}

export interface ScenarioResult {
  readonly name: string;
  readonly kind: "scenario" | "soak";
  readonly status: Status;
  readonly seed: number;
  readonly assertions: readonly AssertionResult[];
  /** Problems with the scenario itself, as opposed to with the system it describes. */
  readonly errors: readonly string[];
  readonly notes: readonly string[];
  readonly trace: Trace;
  /** How far the virtual clock travelled. */
  readonly elapsedMs: number;
}

export interface RunOptions extends EngineOptions {
  /** Run `soak` declarations too. Off by default so a commit-time suite stays fast. */
  readonly soaks?: boolean;
  /** A ceiling on generated load, so a mis-written soak cannot hang the process. */
  readonly maxPublishes?: number;
}

const MAX_PUBLISHES = 100_000;

// ---- name resolution --------------------------------------------------------

/**
 * A pipe named in a scenario, including the implicit dead-letter pipe.
 *
 * `commands.dead` is not a declaration — it is the implicit companion of
 * `commands` — so it cannot be resolved by lookup and has to be recognized.
 */
function resolvePipe(
  model: LinkedModel,
  pkg: string,
  text: string,
): { readonly name: string; readonly pipe: PipeIr } | undefined {
  const direct = model.lookup(pkg, text);
  if (direct !== undefined && direct.kind === "pipe") {
    return { name: qualify(direct.id), pipe: direct };
  }

  if (text.endsWith(".dead")) {
    const base = model.lookup(pkg, text.slice(0, -".dead".length));
    if (base !== undefined && base.kind === "pipe") {
      return { name: `${qualify(base.id)}.dead`, pipe: base };
    }
  }

  return undefined;
}

const resolveMessage = (model: LinkedModel, pkg: string, text: string): MessageIr | undefined => {
  const decl = model.lookup(pkg, text);
  return decl !== undefined && decl.kind === "message" ? decl : undefined;
};

const resolveService = (model: LinkedModel, pkg: string, text: string): ServiceIr | undefined => {
  const decl = model.lookup(pkg, text);
  return decl !== undefined && decl.kind === "service" ? decl : undefined;
};

/**
 * The pipe a publish goes on.
 *
 * `as <Service>` names the sender, and the pipe comes from that service's `emits`
 * clause — the model already says where this service puts this message, so a
 * scenario repeating it would be a second place to keep in step.
 */
function pipeForPublish(
  model: LinkedModel,
  pkg: string,
  message: MessageIr,
  sender: ServiceIr | undefined,
): { readonly pipe: PipeIr; readonly ambiguous?: readonly string[] } | undefined {
  const candidates: PipeIr[] = [];
  const services = sender === undefined ? model.decls.filter((d) => d.kind === "service") : [sender];

  for (const service of services) {
    if (service.kind !== "service") continue;
    for (const emit of service.emits) {
      const emitted = model.resolve(emit.message);
      if (emitted === undefined || qualify(emitted) !== qualify(message.id)) continue;
      const pipe = model.declFor(emit.pipe);
      if (pipe !== undefined && pipe.kind === "pipe" && !candidates.includes(pipe)) {
        candidates.push(pipe);
      }
    }
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return { pipe: candidates[0]! };
  return { pipe: candidates[0]!, ambiguous: candidates.map((p) => qualify(p.id)) };
}

// ---- payload matching -------------------------------------------------------

const sameScalar = (expected: JsonValue, actual: JsonValue): boolean => {
  if (expected === actual) return true;
  // A decimal travels as a string, so `19.99` and `"19.99"` are the same value.
  if (typeof expected === "number" && typeof actual === "string") return String(expected) === actual;
  if (typeof expected === "string" && typeof actual === "number") return expected === String(actual);
  return false;
};

/**
 * Partial matching is the default, because asserting every field makes a scenario
 * brittle to additive changes — which are explicitly non-breaking
 * (`docs/spec/02-contract.md` section 5.2). `exactly` is there for when you do mean
 * "and nothing else changed".
 *
 * A generator directive left in an expectation is a wildcard: it asserts the field is
 * present without asserting what was drawn for it.
 */
function matches(expected: JsonValue, actual: JsonValue, exact: boolean): boolean {
  if (expected !== null && typeof expected === "object" && "directive" in expected) {
    return actual !== undefined;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((v, i) => matches(v, actual[i]!, exact));
  }

  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const a = actual as Record<string, JsonValue>;
    const e = expected as Record<string, JsonValue>;
    if (exact && Object.keys(a).length !== Object.keys(e).length) return false;
    return Object.entries(e).every(([k, v]) => matches(v, a[k] as JsonValue, exact));
  }

  return sameScalar(expected, actual);
}

// ---- rendering --------------------------------------------------------------

function render(expect: Expect): string {
  switch (expect.e) {
    case "message": {
      const what = expect.message ?? "message";
      const parts = [
        expect.negated ? `no ${what}` : what,
        expect.pipe === undefined ? undefined : `on ${expect.pipe}`,
        expect.payload === undefined ? undefined : expect.exact ? "exactly { ... }" : "{ ... }",
        expect.count === undefined ? undefined : `count ${expect.count}`,
      ];
      return `expect ${parts.filter((p) => p !== undefined).join(" ")}`;
    }
    case "handled":
      return `expect ${expect.service} handled ${expect.message}${
        expect.count === undefined ? "" : ` count ${expect.count}`
      }`;
    case "rejected":
      return `expect rejected ${expect.message}${expect.service === undefined ? "" : ` at ${expect.service}`}${
        expect.reason === undefined ? "" : ` reason ${expect.reason}`
      }`;
    case "sagaState":
      return `expect saga ${expect.saga}["${expect.key}"].${expect.property} == ${expect.value}`;
    case "sagaCount":
      return `expect saga ${expect.saga} count ${expect.count}`;
    case "noStuckSaga":
      return `expect no stuck saga ${expect.saga}`;
  }
}

// ---- the runner -------------------------------------------------------------

export async function runScenario(
  model: LinkedModel,
  file: ScenarioFile,
  scenario: Scenario,
  options: RunOptions = {},
): Promise<ScenarioResult> {
  const engine = new Engine(model, file, scenario, options);
  const pkg = file.package;
  const start = engine.clock.now();
  const errors: string[] = [];
  const assertions: AssertionResult[] = [];
  const budget = options.maxPublishes ?? MAX_PUBLISHES;
  let published = 0;

  /** Resolves and sends one `publish` step. */
  const send = (publish: Publish): void => {
    if (published >= budget) return;
    published++;

    const message = resolveMessage(model, pkg, publish.message);
    if (message === undefined) {
      errors.push(`\`${publish.message}\` is not a message visible from ${pkg}`);
      return;
    }

    const sender = publish.as === undefined ? undefined : resolveService(model, pkg, publish.as);
    if (publish.as !== undefined && sender === undefined) {
      errors.push(`\`${publish.as}\` is not a service visible from ${pkg}`);
      return;
    }

    const target = pipeForPublish(model, pkg, message, sender);
    if (target === undefined) {
      errors.push(
        `nothing declares \`emits ${publish.message}\`${
          publish.as === undefined ? "" : ` on \`${publish.as}\``
        }, so there is no pipe to publish it on`,
      );
      return;
    }
    if (target.ambiguous !== undefined) {
      errors.push(
        `\`${publish.message}\` is emitted to more than one pipe (${target.ambiguous.join(", ")}); ` +
          "name the sender with `as <Service>` to say which",
      );
      return;
    }

    const { problems } = engine.publish(
      message,
      target.pipe,
      (publish.payload ?? {}) as Record<string, JsonValue>,
      {
        ...(sender === undefined ? {} : { from: sender.id.name }),
        ...(publish.claims === undefined ? {} : { claims: publish.claims as Claims }),
        ...(publish.envelope === undefined
          ? {}
          : { envelope: publish.envelope as Record<string, JsonValue> }),
        checked: !publish.unchecked,
      },
    );

    // Validation is advisory and `unchecked` is the opt-out, so a refusal is reported
    // where the payload was written rather than three hops away as a dead-letter.
    if (problems.length > 0) {
      errors.push(
        `the payload for \`${publish.message}\` violates its own contract, so it was not sent; ` +
          `write \`unchecked\` to send it anyway: ${problems
            .map((p) => `${p.path}: ${p.message}`)
            .join("; ")}`,
      );
    }
  };

  // ---- steps ---------------------------------------------------------------

  for (const step of scenario.steps) {
    switch (step.s) {
      case "publish":
        // `at` is a point on the scenario's own clock, so it never moves time
        // backwards; a step already in the past simply happens now.
        await engine.advanceTo(start + step.atMs);
        send(step.publish);
        await engine.drain();
        break;

      case "repeat": {
        const every = Math.max(1, step.everyMs);
        for (let t = 0; t <= step.forMs && published < budget; t += every) {
          await engine.advanceTo(start + t);
          send(step.publish);
        }
        break;
      }

      case "advance":
        await engine.advance(step.byMs);
        break;

      case "expect":
        // Everything due has to have happened before the trace is judged, or an
        // assertion would be about when it was written rather than about the system.
        await engine.drain();
        assertions.push(judge(engine, model, pkg, step.expect));
        break;
    }
  }

  // Whatever is still in flight after the last step runs out, so the trace is
  // complete: a dead-letter that was one backoff away should still show up.
  await engine.runToQuiescence();

  // A scenario that asserts about a saga is a claim about the saga, and this runtime
  // stops at the Topology layer. Its message assertions are reported as they came out,
  // but the scenario as a whole is `unsupported` rather than failed: most of what did
  // not happen did not happen because the saga never ran, and reporting that as red
  // would point at the topology for a gap in the runtime.
  const judgesASaga = assertions.some((a) => a.status === "unsupported");

  const status: Status = judgesASaga
    ? "unsupported"
    : errors.length > 0 || assertions.some((a) => a.status === "fail")
      ? "fail"
      : "pass";

  return {
    name: scenario.name,
    kind: scenario.kind,
    status,
    seed: engine.rng.seed,
    assertions,
    errors,
    notes: [...new Set(engine.notes)],
    trace: engine.trace,
    elapsedMs: engine.clock.now() - start,
  };
}

// ---- judging ----------------------------------------------------------------

function judge(engine: Engine, model: LinkedModel, pkg: string, expect: Expect): AssertionResult {
  const text = render(expect);
  const pass = (): AssertionResult => ({ status: "pass", text });
  const fail = (detail: string): AssertionResult => ({ status: "fail", text, detail });
  const unsupported = (detail: string): AssertionResult => ({ status: "unsupported", text, detail });

  const events = engine.trace.all();

  switch (expect.e) {
    case "message": {
      let candidates: readonly TraceEvent[] = events.filter(
        // A dead-letter *is* the message arriving on the dead-letter pipe, so both
        // count as the message being on a pipe.
        (e) => e.kind === "published" || e.kind === "dead-lettered",
      );

      if (expect.pipe !== undefined) {
        const pipe = resolvePipe(model, pkg, expect.pipe);
        if (pipe === undefined) return fail(`\`${expect.pipe}\` is not a pipe visible from ${pkg}`);
        candidates = candidates.filter((e) => e.pipe === pipe.name);
      }

      if (expect.message !== undefined) {
        const message = resolveMessage(model, pkg, expect.message);
        if (message === undefined) {
          return fail(`\`${expect.message}\` is not a message visible from ${pkg}`);
        }
        const type = qualify(message.id);
        candidates = candidates.filter((e) => e.message === type);
      }

      if (expect.payload !== undefined) {
        candidates = candidates.filter(
          (e) => e.body !== undefined && matches(expect.payload!, e.body as JsonValue, expect.exact),
        );
      }

      const found = candidates.length;
      const want = expect.negated ? 0 : expect.count;

      if (want !== undefined) {
        return found === want ? pass() : fail(`expected ${want}, found ${found}`);
      }
      return found > 0 ? pass() : fail("found none");
    }

    case "handled": {
      const service = resolveService(model, pkg, expect.service);
      if (service === undefined) {
        return fail(`\`${expect.service}\` is not a service visible from ${pkg}`);
      }
      const message = resolveMessage(model, pkg, expect.message);
      if (message === undefined) {
        return fail(`\`${expect.message}\` is not a message visible from ${pkg}`);
      }
      const type = qualify(message.id);
      const found = events.filter(
        (e) => e.kind === "handled" && e.service === service.id.name && e.message === type,
      ).length;

      if (expect.count !== undefined) {
        return found === expect.count ? pass() : fail(`expected ${expect.count}, found ${found}`);
      }
      return found > 0 ? pass() : fail("found none");
    }

    case "rejected": {
      const message = resolveMessage(model, pkg, expect.message);
      if (message === undefined) {
        return fail(`\`${expect.message}\` is not a message visible from ${pkg}`);
      }
      const type = qualify(message.id);

      let found = events.filter((e) => e.kind === "rejected" && e.message === type);

      if (expect.service !== undefined) {
        const service = resolveService(model, pkg, expect.service);
        if (service === undefined) {
          return fail(`\`${expect.service}\` is not a service visible from ${pkg}`);
        }
        found = found.filter((e) => e.service === service.id.name);
      }
      if (expect.reason !== undefined) {
        const wanted = expect.reason.toLowerCase();
        found = found.filter((e) => e.reason === wanted);
      }

      if (found.length > 0) return pass();

      const other = events.filter((e) => e.kind === "rejected" && e.message === type);
      return fail(
        other.length === 0
          ? "no rejection was recorded"
          : `rejected, but for ${other.map((e) => e.reason ?? "no reason").join(", ")}`,
      );
    }

    // Sagas are the Process layer, and this runtime stops at Topology. Reported
    // rather than skipped: an assertion that silently passes is worse than one that
    // says it was not checked.
    case "sagaState":
    case "sagaCount":
    case "noStuckSaga":
      return unsupported("this runtime does not yet run sagas");
  }
}

// ---- a whole file -----------------------------------------------------------

export interface FileResult {
  readonly file: string;
  readonly package: string;
  readonly scenarios: readonly ScenarioResult[];
}

export async function runFile(
  model: LinkedModel,
  file: ScenarioFile,
  options: RunOptions = {},
  live: ReadonlyMap<string, Handler> = new Map(),
): Promise<FileResult> {
  const results: ScenarioResult[] = [];

  for (const scenario of file.scenarios) {
    if (scenario.kind === "soak" && options.soaks !== true) continue;
    results.push(await runScenario(model, file, scenario, { ...options, live }));
  }

  return { file: file.file, package: file.package, scenarios: results };
}
