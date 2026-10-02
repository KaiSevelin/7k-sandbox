/**
 * Messages on the wire.
 *
 * An envelope is kept separate from the body because that is how canonical JSON encodes it
 * (`docs/spec/01-kernel.md` section 7.3), and because a filter may read the envelope and not the body — a
 * distinction the engine has to honour rather than merely document.
 *
 * **What a predicate means is not here.** It is in Core, where two runtimes cannot disagree about it
 * (7k D97). This file holds the runtime's own shapes and the one adapter between them.
 */

import { evaluate as evaluateView, type JsonValue, type PayloadView, type Predicate } from "@sevenk/core";
import type { VirtualTime } from "./clock.js";

export type Claims = Readonly<Record<string, JsonValue>>;

export interface Envelope {
  /** Per-send identity. Distinct from the business key, which identifies the work. */
  readonly id: string;
  readonly type: string;
  readonly version?: string;
  readonly time: VirtualTime;
  /** Declared envelope records, flattened. Propagated on every hop (D50). */
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface Message {
  readonly envelope: Envelope;
  readonly body: Readonly<Record<string, JsonValue>>;
  /**
   * Who sent it: a **qualified** service name, or `"scenario"` when the scenario published it
   * itself. Read by the trace, which writes it as `service` (`30-scenarios.md` 7.6).
   */
  readonly from: string;
  readonly claims: Claims;
}

// ---- predicates -------------------------------------------------------------

/**
 * A message as the contract layer sees it: three tiers and nothing about this runtime.
 *
 * `Message` is structurally this plus `from`, so the adapter is a projection rather than a conversion.
 */
export const viewOf = (message: Message): PayloadView => ({
  body: message.body,
  envelope: message.envelope.fields,
  claims: message.claims,
});

/**
 * Evaluates a predicate against a message.
 *
 * Core decides what it means (`evaluate`); this only says which parts of a message are which.
 */
export const evaluate = (predicate: Predicate, message: Message): boolean =>
  evaluateView(predicate, viewOf(message));

export { readPath } from "@sevenk/core";
