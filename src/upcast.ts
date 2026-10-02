/**
 * Translating an older message to the version a consumer understands.
 *
 * An `upcast` is declared in the model "so that generated code has one canonical home for it
 * and the sandbox can exercise it" (`docs/spec/02-contract.md` section 5.4). It was neither
 * until now: Core resolved the declaration, dropped its body, and nothing applied it — a
 * declared migration that did nothing, which is worse than one that is missing, because the
 * model reads as though versioning works.
 *
 * Two things make it runnable without a second copy of each message's history.
 *
 * **A message's older shape comes from `@since`.** The model holds one declaration, at the
 * current version, and each field records the version it arrived in. The fields a message had
 * at v1.0 are therefore the ones with no `@since` later than 1.0 — which is also exactly what
 * `version-classification` reads, so the two agree by construction.
 *
 * **Upcasts chain.** A v1.0 message reaching a v1.2 consumer applies 1.0→1.1 then 1.1→1.2.
 * Each step is assignment from a field path, a literal or `absent`, and nothing else: anything
 * needing computation is a translating service, not an upcast.
 */

import {
  parseVersion,
  qualify,
  type AssignIr,
  type FieldIr,
  type JsonValue,
  type LinkedModel,
  type MessageIr,
  type UpcastIr,
  type Version,
} from "@sevenk/core";

/** Whether a field existed at a version: everything but what arrived later. */
export function fieldAt(field: FieldIr, at: Version): boolean {
  if (field.since === undefined) return true;
  const since = parseVersion(field.since);
  if (since === undefined) return true;
  return since.major < at.major || (since.major === at.major && since.minor <= at.minor);
}

/** The fields a message had at a version, from what `@since` records. */
export const shapeAt = (message: MessageIr, at: Version): FieldIr[] =>
  message.fields.filter((f) => fieldAt(f, at));

const order = (v: Version): number => v.major * 1_000_000 + v.minor;

/**
 * The upcasts that carry a message from one version to another, in order.
 *
 * Returns nothing when the chain is broken, because applying half of it would produce a shape
 * that is neither version — and a runtime guessing at a missing step is how a migration comes
 * to be believed rather than checked.
 */
export function chain(
  model: LinkedModel,
  message: MessageIr,
  from: Version,
  to: Version,
): { readonly steps: readonly UpcastIr[]; readonly gap?: string } {
  if (order(from) >= order(to)) return { steps: [] };

  const mine = model.decls.filter((d): d is UpcastIr => {
    if (d.kind !== "upcast") return false;
    const target = model.resolve(d.message);
    return target !== undefined && qualify(target) === qualify(message.id);
  });

  const steps: UpcastIr[] = [];
  let at = from;

  for (let guard = 0; guard < 64; guard++) {
    if (order(at) >= order(to)) return { steps };

    const next = mine.find((u) => {
      const f = u.from === undefined ? undefined : parseVersion(u.from);
      return f !== undefined && order(f) === order(at);
    });
    if (next === undefined) {
      return {
        steps,
        gap: `no \`upcast ${message.id.name} v${at.major}.${at.minor} to ...\` is declared`,
      };
    }

    const landed = next.to === undefined ? undefined : parseVersion(next.to);
    if (landed === undefined || order(landed) <= order(at)) {
      return { steps, gap: `\`upcast ${message.id.name} v${next.from ?? "?"}\` does not move forward` };
    }

    steps.push(next);
    at = landed;
  }

  return { steps, gap: "the upcast chain does not terminate" };
}

/** Reads an upcast source against the message being translated. */
function sourceOf(assign: AssignIr, body: Readonly<Record<string, JsonValue>>): JsonValue | undefined {
  const source = assign.source;
  if (source.from === "absent") return undefined;
  if (source.from === "literal") return source.value;
  // Only the body is in hand: an upcast translates a payload, and `envelope`, `claim`, `state`
  // and `occurrence` belong to senders and processes rather than to a message's own shape. A
  // bare path is the form the specification names — "assignment from a field path" — and
  // `message.x` says the same thing explicitly.
  if (source.from !== "message" && source.from !== "path") return undefined;

  return source.path.reduce<JsonValue | undefined>(
    (acc, segment) =>
      acc !== null && acc !== undefined && typeof acc === "object" && !Array.isArray(acc)
        ? (acc as Record<string, JsonValue>)[segment]
        : undefined,
    body as JsonValue,
  );
}

export interface Applied {
  readonly body: Record<string, JsonValue>;
  /** The versions walked through, for the trace. */
  readonly through: readonly string[];
  /** Why the chain stopped short, if it did. */
  readonly gap?: string;
}

/**
 * Applies the chain from the version a message carries to the one a consumer understands.
 *
 * A source path reads the body **as it was before this step**, so a rename — a remove plus an
 * add, and therefore a major change — reads the old name and writes the new one in one
 * assignment.
 */
export function apply(
  model: LinkedModel,
  message: MessageIr,
  body: Readonly<Record<string, JsonValue>>,
  from: Version,
  to: Version,
): Applied {
  const { steps, gap } = chain(model, message, from, to);

  let current: Record<string, JsonValue> = { ...body };
  const through: string[] = [];

  for (const step of steps) {
    const before = current;
    const next: Record<string, JsonValue> = { ...before };

    for (const assign of step.assigns) {
      const target = assign.target[0];
      if (target === undefined || assign.target.length > 1) continue;

      const value = sourceOf(assign, before);
      // There is no null in 7K, so `absent` removes the key rather than setting one.
      if (value === undefined) delete next[target];
      else next[target] = value;
    }

    current = next;
    if (step.to !== undefined) through.push(step.to);
  }

  return { body: current, through, ...(gap === undefined ? {} : { gap }) };
}
