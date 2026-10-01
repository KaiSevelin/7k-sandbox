/**
 * Messages on the wire, and the evaluation of predicates against them.
 *
 * An envelope is kept separate from the body because that is how canonical JSON
 * encodes it (`docs/spec/01-kernel.md` section 7.3), and because a filter may read
 * the envelope and not the body — a distinction the engine has to honour rather
 * than merely document.
 */

import {
  isDirective,
  type JsonValue,
  type Operand,
  type Predicate,
} from "@sevenk/core";
import type { Rng } from "./clock.js";
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
  /** Who sent it. Envelope propagation and `requires` both depend on it. */
  readonly from: string;
  readonly claims: Claims;
}

// ---- paths ------------------------------------------------------------------

/**
 * Reads a path, honouring the two forms a path may take: `[]` projects over every
 * element, and `.size` reads a list's length (`docs/spec/10-grammar.md`).
 *
 * A projection yields an array of results, which is what lets a comparison mean
 * "for every element".
 */
export function readPath(root: JsonValue, path: readonly string[]): JsonValue | JsonValue[] {
  let current: JsonValue | JsonValue[] = root;

  for (const [i, segment] of path.entries()) {
    if (segment === "[]") {
      if (!Array.isArray(current)) return undefined as unknown as JsonValue;
      const rest = path.slice(i + 1);
      return current.flatMap((item) => {
        const read = readPath(item, rest);
        return Array.isArray(read) ? read : [read];
      });
    }

    if (Array.isArray(current)) {
      if (segment === "size") return current.length;
      return current.map((item) => readPath(item, path.slice(i))).flat();
    }

    if (current === null || typeof current !== "object") return undefined as unknown as JsonValue;
    if (isDirective(current as JsonValue)) return undefined as unknown as JsonValue;

    const next = (current as Record<string, JsonValue>)[segment];
    if (next === undefined && segment === "size") return 0;
    current = next as JsonValue;
  }

  return current;
}

// ---- predicate evaluation ---------------------------------------------------

/** Resolves an operand against a message. Undefined means "absent". */
function valueOf(operand: Operand, message: Message): JsonValue | JsonValue[] | undefined {
  switch (operand.k) {
    case "literal":
      return operand.value;
    case "list":
      return operand.values as JsonValue[];
    case "claim":
      return message.claims[operand.name];
    case "envelope":
      return readPath(message.envelope.fields, operand.path);
    case "message":
    case "field":
      return readPath(message.body, operand.path);
  }
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean => {
  if (a === b) return true;
  // A decimal travels as a string, so `19.99` and `"19.99"` are the same value
  // (`docs/spec/01-kernel.md` section 7.1).
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return false;
};

const compare = (op: string, a: JsonValue | undefined, b: JsonValue | undefined): boolean => {
  switch (op) {
    case "==":
      return same(a, b);
    case "!=":
      return !same(a, b);
    case "in":
      return Array.isArray(b) && b.some((v) => same(a, v));
    case "contains":
      if (Array.isArray(a)) return a.some((v) => same(v, b));
      if (typeof a === "string") {
        // A scope claim is conventionally space-separated, so `contains` means
        // "holds this scope" rather than "has this substring".
        if (typeof b !== "string") return false;
        return a === b || a.split(/\s+/).includes(b);
      }
      return false;
    default: {
      const x = typeof a === "string" ? Number(a) : a;
      const y = typeof b === "string" ? Number(b) : b;
      if (typeof x !== "number" || typeof y !== "number" || Number.isNaN(x) || Number.isNaN(y)) {
        return false;
      }
      switch (op) {
        case "<":
          return x < y;
        case "<=":
          return x <= y;
        case ">":
          return x > y;
        case ">=":
          return x >= y;
        default:
          return false;
      }
    }
  }
};

/**
 * Evaluates a predicate. Never throws: an unknown predicate, an absent field or a
 * type mismatch is **false**, because a filter that crashes the engine would be
 * worse than one that declines to match.
 *
 * A projected operand means "for every element", so a comparison over `[]` holds
 * only when it holds for all of them.
 */
export function evaluate(predicate: Predicate, message: Message): boolean {
  switch (predicate.p) {
    case "and":
      return predicate.operands.every((p) => evaluate(p, message));
    case "or":
      return predicate.operands.some((p) => evaluate(p, message));
    case "not":
      return !evaluate(predicate.operand, message);
    case "unknown":
      return false;
    case "cmp": {
      const left = valueOf(predicate.left, message);
      const right = valueOf(predicate.right, message);

      const projected = predicate.left.k !== "list" && Array.isArray(left);
      if (projected && predicate.op !== "contains") {
        const items = left as JsonValue[];
        return items.length > 0 && items.every((v) => compare(predicate.op, v, right as JsonValue));
      }
      return compare(predicate.op, left as JsonValue, right as JsonValue);
    }
  }
}

// ---- generator directives ---------------------------------------------------

/**
 * Resolves canonical-JSON generator directives (`docs/spec/01-kernel.md` section
 * 7.5). Only a runtime can: `$auto` needs the seed, `$now` needs the clock.
 *
 * `$invalid` deliberately produces a value that violates its field's constraints,
 * because testing a rejection path is otherwise impossible.
 */
export function resolveDirectives(value: JsonValue, rng: Rng, now: VirtualTime): JsonValue {
  if (Array.isArray(value)) return value.map((v) => resolveDirectives(v, rng, now));

  if (value !== null && typeof value === "object") {
    if (isDirective(value)) {
      switch (value.directive) {
        case "auto":
          return rng.uuid();
        case "now": {
          const offset = typeof value.args === "string" ? value.args : "";
          return new Date(now + offsetMs(offset)).toISOString();
        }
        case "range": {
          const bounds = Array.isArray(value.args) ? value.args : [];
          const low = Number(bounds[0] ?? 0);
          const high = Number(bounds[1] ?? low);
          return low + rng.int(high - low + 1);
        }
        case "repeat": {
          const args = value.args as Record<string, JsonValue>;
          const rawCount = args.value ?? args;
          const count = Number(resolveDirectives(rawCount as JsonValue, rng, now));
          const of = args.of ?? "";
          return Array.from({ length: Number.isFinite(count) ? count : 0 }, () =>
            resolveDirectives(of, rng, now),
          );
        }
        case "example":
          return "";
        case "invalid":
          // A long string violates a length constraint; the engine does not need
          // to know which constraint it was asked to break.
          return "x".repeat(4096);
        default:
          return "";
      }
    }

    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
      out[k] = resolveDirectives(v, rng, now);
    }
    return out;
  }

  return value;
}

/** `+15m`, `-2h`, `15m`. */
function offsetMs(text: string): number {
  const m = /^([+-]?)(\d+)(ms|s|m|h|d)$/.exec(text.trim());
  if (m === null) return 0;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[4]!]!;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * unit;
}
