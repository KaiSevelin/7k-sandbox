/**
 * The 7K sandbox: a deterministic in-process runtime for a 7K model.
 *
 * Its reason for existing is that a message-driven system's hard parts are all about
 * time and failure — a retry storm, a dead letter, a saga that never completes, a
 * duplicate that was supposed to be idempotent — and none of them are observable at
 * the speed and scale a real broker runs at. A virtual clock makes `advance 30d`
 * finish in microseconds, and a seed makes a bug report a model plus a number.
 *
 * Everything the language means is imported from `@sevenk/core`: the parser, the IR,
 * the analyses, and the lowering of scenarios. This package decides only what
 * *happens*, never what anything means — two runtimes disagreeing about what a filter
 * or a mock denotes would make the conformance suite worthless.
 */

export {
  Clock,
  EventQueue,
  Rng,
  type ClockOptions,
  type ScheduledEvent,
  type VirtualTime,
} from "./clock.js";

export { evaluate, readPath, type Claims, type Envelope, type Message } from "./message.js";

export {
  Trace,
  type TraceEvent,
  type TraceKind,
  type TraceReason,
} from "./trace.js";

export {
  bounds,
  envelopeFields,
  examples,
  fieldSpec,
  flatFields,
  generate,
  invalid,
  normalizeString,
  normalizeValue,
  prepareBody,
  prepareEnvelope,
  resolve as resolveAgainst,
  specOf,
  validate,
  type Bounds,
  type BodyResult,
  type Problem,
  type Spec,
} from "./schema.js";

export {
  firingsBetween,
  isCronProblem,
  knownZone,
  nextFiring,
  parseCron,
  type Cron,
  type CronProblem,
} from "./cron.js";

export { Sagas, type Instance, type SagaHost } from "./saga.js";

export { Schedules, type ScheduleHost } from "./schedule.js";

export {
  apply as applyUpcasts,
  chain as upcastChain,
  fieldAt,
  shapeAt,
  type Applied,
} from "./upcast.js";

export {
  Engine,
  type EngineOptions,
  type Handler,
  type HandlerResult,
} from "./engine.js";

export {
  runFile,
  runScenario,
  type AssertionResult,
  type FileResult,
  type RunOptions,
  type ScenarioResult,
  type Status,
} from "./runner.js";

export { load, run, type LoadResult, type RunReport } from "./load.js";
