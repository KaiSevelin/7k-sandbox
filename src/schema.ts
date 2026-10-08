/**
 * What a *runtime* decides about a payload.
 *
 * Generating a value from a seeded RNG, resolving a `"$auto"` directive against a virtual clock,
 * preparing a body and an envelope for the wire. All of it depends on this runtime's clock and its
 * seed, which is exactly why it is here.
 *
 * **What the contract decides is not here.** A `Spec`, what `length 3..254` admits, what
 * `normalize trim` does, whether an invariant holds — those are in Core, because two runtimes
 * disagreeing about any of them would make the conformance suite worthless (7k D97). They lived here
 * until Spider's composer became the second consumer.
 */

import {
  UNKNOWN,
  bounds,
  constraint,
  examples,
  fieldSpec,
  flatFieldsOf,
  isResolved,
  normalizeString,
  normalizeValue,
  range,
  specOf,
  specOfDecl,
  symbolKey,
  validate,
  windowOf,
  type Bounds,
  type ConstraintIr,
  type Context,
  type Decl,
  type FieldIr,
  type JsonValue,
  type LinkedModel,
  type MessageIr,
  type Problem,
  type RecordIr,
  type Spec,
  type TypeIr,
  type ValueIr,
} from "@sevenk/core";
import { isDirective } from "@sevenk/core";
import type { Rng, VirtualTime } from "./clock.js";
import { type Message } from "./message.js";

// Re-exported where this runtime's own modules already reach for them through here, so the move is not
// a rename for every caller.
export {
  bounds,
  examples,
  fieldSpec,
  normalizeString,
  normalizeValue,
  specOf,
  specOfDecl,
  validate,
  type Bounds,
  type Context,
  type Problem,
  type Spec,
};

/** The alphabet an invented string is drawn from: unambiguous in a log and in a terminal. */
const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** The flattened fields of a record, message or envelope. Core's, through here for the old callers. */
export const flatFields = (model: LinkedModel, decl: Decl, depth = 0): FieldIr[] =>
  flatFieldsOf(model, decl, depth);

/**
 * A valid value for a spec, drawn from the seed.
 *
 * Varying rather than constant, because a `unique` list of generated elements has
 * to actually be unique. `$example` is how a scenario asks for the declared example
 * instead.
 */
export function generate(model: LinkedModel, spec: Spec, rng: Rng, now: VirtualTime, depth = 0): JsonValue {
  if (depth > 12) return "";

  switch (spec.shape) {
    case "enum":
      return rng.pick(spec.members ?? []) ?? "";

    case "list": {
      const size = windowOf(spec, "size");
      const low = size.min ?? 1;
      const count = size.max === undefined ? low : low + rng.int(Math.min(size.max, low + 2) - low + 1);
      if (spec.item === undefined) return [];
      return Array.from({ length: count }, () => generate(model, spec.item!, rng, now, depth + 1));
    }

    case "record": {
      const out: Record<string, JsonValue> = {};
      for (const field of spec.fields ?? []) {
        // Absent is absent: an optional field is left out, which is the safe choice
        // and keeps a generated fixture minimal.
        if (field.optional) continue;
        out[field.name] = generate(model, fieldSpec(model, field), rng, now, depth + 1);
      }
      return out;
    }

    case "map":
      return {};

    case "unknown":
      return "";

    case "scalar":
      return generateScalar(spec, rng, now);
  }
}

function generateScalar(spec: Spec, rng: Rng, now: VirtualTime): JsonValue {
  switch (spec.kernel) {
    case "bool":
      return rng.chance(50);

    case "uuid":
      return rng.uuid();

    case "instant":
      return new Date(now).toISOString();

    case "date":
      return new Date(now).toISOString().slice(0, 10);

    case "duration":
      return "PT30S";

    case "bytes":
      return "";

    case "int": {
      const r = range(spec);
      const low = r.min ?? 0;
      const high = r.max ?? low + 1000;
      const by = Number(constraint(spec, "multipleof")?.args[0] ?? 1);
      const drawn = low + rng.int(Math.max(1, high - low + 1));
      return Number.isFinite(by) && by > 1 ? Math.max(low, drawn - (drawn % by)) : drawn;
    }

    case "float": {
      const r = range(spec);
      const low = r.min ?? 0;
      const high = r.max ?? low + 1;
      return low + rng.next() * (high - low);
    }

    case "decimal": {
      const scale = spec.scale ?? 2;
      const r = range(spec);
      const low = r.min ?? 0;
      const high = r.max ?? low + 1000;
      const whole = low + rng.int(Math.max(1, Math.floor(high - low) + 1));
      return `${whole}.${"0".repeat(scale)}`;
    }

    case "string": {
      const len = windowOf(spec, "length");
      // A pattern is an escape hatch the generator cannot invert, so a declared
      // example is the only honest source for one.
      if (constraint(spec, "pattern") !== undefined) {
        const declared = examples(spec);
        if (declared.length > 0) return rng.pick(declared)!;
      }
      const low = Math.max(1, len.min ?? 1);
      const high = Math.max(low, Math.min(len.max ?? low + 7, low + 7));
      const count = low + rng.int(high - low + 1);
      const text = Array.from({ length: count }, () => ALPHANUM[rng.int(ALPHANUM.length)]).join("");
      return normalizeString(spec, text);
    }

    default:
      return "";
  }
}

/**
 * A value that deliberately violates the spec, for `$invalid`.
 *
 * Without this a negative test is impossible to write, which would leave the
 * consumer's rejection path and its dead-letter queue untestable — half the
 * behaviour that matters in a message-driven system.
 */
export function invalid(spec: Spec, which: string | undefined): JsonValue {
  const named = (which ?? "").toLowerCase();

  if (spec.shape === "list") {
    const size = windowOf(spec, "size");
    return size.min !== undefined && size.min > 0 ? [] : Array.from({ length: (size.max ?? 1) + 1 }, () => "x");
  }
  if (spec.shape === "enum") return "NotAMember";

  switch (spec.kernel) {
    case "string": {
      const len = windowOf(spec, "length");
      if (named.includes("min") && len.min !== undefined && len.min > 0) return "";
      return "x".repeat((len.max ?? 255) + 1);
    }
    case "int":
    case "float":
    case "decimal": {
      const r = range(spec);
      if (r.max !== undefined) return spec.kernel === "decimal" ? `${r.max + 1}.00` : r.max + 1;
      if (r.min !== undefined) return spec.kernel === "decimal" ? `${r.min - 1}.00` : r.min - 1;
      return spec.kernel === "decimal" ? "not-a-decimal" : "not-a-number";
    }
    case "uuid":
      return "not-a-uuid";
    case "instant":
    case "date":
      return "not-a-timestamp";
    case "bool":
      return "not-a-bool";
    default:
      return "x".repeat(4096);
  }
}

// ---- directive resolution against a spec ------------------------------------

/**
 * Resolves generator directives with the field's type in hand, which is what makes
 * `"$auto"` mean "valid here" rather than "a uuid".
 */
export function resolve(
  model: LinkedModel,
  spec: Spec,
  value: JsonValue,
  rng: Rng,
  now: VirtualTime,
  depth = 0,
): JsonValue {
  if (depth > 24) return value;

  if (Array.isArray(value)) {
    const item = spec.item ?? UNKNOWN;
    return value.map((v) => resolve(model, item, v, rng, now, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    if (isDirective(value)) {
      const directive = value.directive;
      const args = value.args;

      switch (directive) {
        case "auto":
          return generate(model, spec, rng, now);

        case "now": {
          const text = typeof args === "string" ? args : "";
          return new Date(now + offsetMs(text)).toISOString();
        }

        case "example": {
          const declared = examples(spec);
          const n = Number(args);
          if (declared.length === 0) return generate(model, spec, rng, now);
          return declared[Number.isFinite(n) ? Math.max(0, n - 1) % declared.length : 0]!;
        }

        case "range": {
          const list = Array.isArray(args) ? args : [];
          const low = Number(list[0] ?? 0);
          const high = Number(list[1] ?? low);
          return low + rng.int(Math.max(1, high - low + 1));
        }

        case "repeat": {
          const object = (args ?? {}) as Record<string, JsonValue>;
          // `{ $repeat: 6, of: X }` lowers with the count as the directive's value
          // and `of` beside it.
          const rawCount = object.value ?? args;
          const count = Number(resolve(model, UNKNOWN, rawCount as JsonValue, rng, now, depth + 1));
          const template = object.of;
          const item = spec.item ?? UNKNOWN;
          return Array.from({ length: Number.isFinite(count) ? Math.max(0, count) : 0 }, () =>
            template === undefined
              ? generate(model, item, rng, now)
              : resolve(model, item, template, rng, now, depth + 1),
          );
        }

        case "invalid":
          return invalid(spec, typeof args === "string" ? args : undefined);

        default:
          return value as JsonValue;
      }
    }

    // A plain object: resolve each declared field against its own type.
    const out: Record<string, JsonValue> = {};
    const byName = new Map((spec.fields ?? []).map((f) => [f.name, f]));
    for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
      const field = byName.get(k);
      out[k] = resolve(model, field === undefined ? UNKNOWN : fieldSpec(model, field), v, rng, now, depth + 1);
    }
    return out;
  }

  // A decimal literal against a `float`, which is the one place a 7K body cannot say what it means.
  //
  // `1.5` lowers to the *string* `"1.5"`, because a `decimal` must never round-trip through a double
  // (`01-kernel.md` 7.1) and the lexer does not know which kernel the field is. A `float` is a JSON
  // number, so the string was then rejected — and a scenario had no way at all to write a `float`
  // field with a fractional part. The field's type is in hand exactly here, which is why this is the
  // place it can be decided.
  //
  // It also lets a quoted `"1.5"` through for a float, which the two forms being indistinguishable
  // after lowering makes unavoidable. That laxity is a scenario body's, not a payload's: nothing off
  // a pipe passes through here, and a scenario that wants to claim the string form is rejected says
  // so with `{ $invalid: "type" }` or `unchecked`.
  if (spec.kernel === "float" && typeof value === "string" && DECIMAL_LITERAL.test(value)) {
    return Number(value);
  }

  return value;
}

const DECIMAL_LITERAL = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** `+15m`, `-2h`, `15m`. */
export function offsetMs(text: string): number {
  const m = /^([+-]?)(\d+)(ms|s|m|h|d)$/.exec(text.trim());
  if (m === null) return 0;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[3]!]!;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * unit;
}

// ---- bodies ----------------------------------------------------------------

export interface BodyResult {
  readonly body: Record<string, JsonValue>;
  readonly problems: readonly Problem[];
}

/**
 * Prepares a body for a message: resolve directives, normalize, then validate —
 * the order generated code uses, because normalization is what makes validation
 * well-defined (`docs/spec/01-kernel.md` section 3).
 *
 * `fill` supplies the fields the author did not write. A mock's reply passes the
 * inbound body, so an unspecified field is **carried from the request** when the
 * names match and generated otherwise: that keeps a mock about the one field it is
 * testing without breaking the correlation a real handler would preserve. A
 * `publish` passes nothing, so a missing required field is the error it would be
 * from a real producer.
 */
export function prepareBody(
  model: LinkedModel,
  message: MessageIr,
  written: Readonly<Record<string, JsonValue>>,
  rng: Rng,
  now: VirtualTime,
  fill?: Readonly<Record<string, JsonValue>>,
  envelope?: Readonly<Record<string, JsonValue>>,
): BodyResult {
  const spec = specOfDecl(model, message, [], 0);
  const resolved = resolve(model, spec, written as JsonValue, rng, now) as Record<string, JsonValue>;

  if (fill !== undefined) {
    for (const field of spec.fields ?? []) {
      if (resolved[field.name] !== undefined || field.optional) continue;
      const carried = fill[field.name];
      const sub = fieldSpec(model, field);
      resolved[field.name] =
        carried !== undefined && validate(model, sub, carried).length === 0
          ? carried
          : generate(model, sub, rng, now);
    }
  }

  const normalized = normalizeValue(model, spec, resolved) as Record<string, JsonValue>;
  return {
    body: normalized,
    problems: validate(model, spec, normalized, "", [], { root: normalized, ...(envelope === undefined ? {} : { envelope }) }),
  };
}

/**
 * The envelope a runtime supplies: every declared envelope field, with what the
 * scenario set taking precedence.
 *
 * A `@derive` field is filled from the inbound message rather than generated, which
 * is how a causation chain survives a hop (D50).
 */
export function prepareEnvelope(
  model: LinkedModel,
  message: MessageIr,
  written: Readonly<Record<string, JsonValue>>,
  rng: Rng,
  now: VirtualTime,
  inbound?: { readonly id: string; readonly fields: Readonly<Record<string, JsonValue>> },
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...written };
  const pkg = model.packages.get(message.id.pkg);

  for (const ref of pkg?.envelopes ?? []) {
    const decl = model.declFor(ref);
    if (decl === undefined || decl.kind !== "envelope") continue;

    for (const field of flatFields(model, decl)) {
      if (out[field.name] !== undefined) continue;

      if (field.derive === "inbound.id" && inbound !== undefined) {
        out[field.name] = inbound.id;
        continue;
      }
      // A field already on the inbound envelope propagates untouched; only a field
      // with no prior value is generated.
      const carried = inbound?.fields[field.name];
      if (carried !== undefined) {
        out[field.name] = carried;
        continue;
      }
      if (field.optional) continue;
      out[field.name] = generate(model, fieldSpec(model, field), rng, now);
    }
  }

  return out;
}

/** The declared envelope fields of a message's package, for a filter to read. */
export function envelopeFields(model: LinkedModel, message: MessageIr): FieldIr[] {
  const pkg = model.packages.get(message.id.pkg);
  const out: FieldIr[] = [];
  for (const ref of pkg?.envelopes ?? []) {
    const decl = model.declFor(ref);
    if (decl !== undefined && decl.kind === "envelope") out.push(...flatFields(model, decl));
  }
  return out;
}
