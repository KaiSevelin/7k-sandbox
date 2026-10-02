/**
 * Messages on the wire, and the evaluation of predicates against them.
 *
 * An envelope is kept separate from the body because that is how canonical JSON
 * encodes it (`docs/spec/01-kernel.md` section 7.3), and because a filter may read
 * the envelope and not the body — a distinction the engine has to honour rather
 * than merely document.
 */

import { isDirective, type JsonValue, type Operand, type Predicate } from "@sevenk/core";
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
  // Absent is not equal to absent. A comparison needs two values, and
  // `claim.tid == envelope.tenantId` holding because a sender presented neither
  // would be the wrong answer in the one place it matters most.
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  // A decimal travels as a string, so `19.99` and `"19.99"` are the same value
  // (`docs/spec/01-kernel.md` section 7.1).
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return false;
};

const compare = (op: string, a: JsonValue | undefined, b: JsonValue | undefined): boolean => {
  // Every comparison needs both sides, including `!=`: "absent differs from absent"
  // is as unfounded as "absent equals absent".
  if (a === undefined || b === undefined) return false;

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

      // A projection distributes, and it may be on either side: an invariant is as likely to be
      // written `total.currency == lines[].unit.currency` as the other way round. Only the first
      // form worked until this, so every invariant with the projection on the right was false.
      const leftProjected = predicate.left.k !== "list" && Array.isArray(left);
      const rightProjected =
        predicate.right.k !== "list" && Array.isArray(right) && predicate.op !== "contains";

      if (leftProjected && rightProjected) {
        const a = left as JsonValue[];
        const b = right as JsonValue[];
        // Element-wise, which is the only reading two projections have: `a[].x == a[].y`.
        return a.length > 0 && a.length === b.length && a.every((v, i) => compare(predicate.op, v, b[i]));
      }

      if (leftProjected && predicate.op !== "contains") {
        const items = left as JsonValue[];
        return items.length > 0 && items.every((v) => compare(predicate.op, v, right as JsonValue));
      }

      if (rightProjected) {
        const items = right as JsonValue[];
        return items.length > 0 && items.every((v) => compare(predicate.op, left as JsonValue, v));
      }

      return compare(predicate.op, left as JsonValue, right as JsonValue);
    }
  }
}
