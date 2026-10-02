/**
 * Generation, normalization and validation of message bodies.
 *
 * All three are the same walk over the same resolved type, which is why they live
 * together. A field's declared type is where its generated value, its
 * canonicalization and its validity all come from, and a runtime that split them
 * would drift: a generator that does not read the constraints produces fixtures its
 * own validator rejects.
 *
 * `"$auto"` is specified as "a valid value drawn from the field's constraints and
 * examples" (`docs/spec/01-kernel.md` section 7.5). That makes it type-directed, not
 * a uuid factory — `$auto` for a `SeatRef { length 1..16 }` must produce something
 * sixteen characters or shorter, and `$auto` for a record must produce a record.
 */

import {
  isDirective,
  showPredicate,
  type ConstraintIr,
  type Decl,
  type FieldIr,
  type JsonValue,
  type KernelName,
  type LinkedModel,
  type MessageIr,
  type Operand,
  type Predicate,
  type TypeIr,
} from "@sevenk/core";
import type { Rng, VirtualTime } from "./clock.js";
import { evaluate, readPath, type Message } from "./message.js";

/** A type flattened through its `value` aliases, carrying every constraint it picked up. */
export interface Spec {
  readonly shape: "scalar" | "record" | "enum" | "list" | "map" | "unknown";
  readonly kernel?: KernelName;
  readonly precision?: number;
  readonly scale?: number;
  readonly constraints: readonly ConstraintIr[];
  readonly fields?: readonly FieldIr[];
  readonly members?: readonly string[];
  readonly item?: Spec;
  readonly value?: Spec;
  /** Contract rules over this record's own data, evaluated once its fields are checked. */
  readonly invariants?: readonly Predicate[];
  /** For a diagnostic: the name as declared. */
  readonly named?: string;
}

const UNKNOWN: Spec = { shape: "unknown", constraints: [] };

// ---- resolving ---------------------------------------------------------------

/**
 * Flattens a type. Constraints accumulate outward-in: `Line60 : Line { length 1..60 }`
 * carries both bounds, and the narrower one is the one that bites.
 */
export function specOf(
  model: LinkedModel,
  type: TypeIr,
  extra: readonly ConstraintIr[] = [],
  depth = 0,
): Spec {
  if (depth > 16) return UNKNOWN; // a cyclic value declaration; reported by the checker

  switch (type.t) {
    case "kernel":
      return {
        shape: "scalar",
        kernel: type.name,
        ...(type.precision !== undefined ? { precision: type.precision } : {}),
        ...(type.scale !== undefined ? { scale: type.scale } : {}),
        constraints: extra,
      };

    case "list":
      return { shape: "list", item: specOf(model, type.item, [], depth + 1), constraints: extra };

    case "map":
      return {
        shape: "map",
        value: specOf(model, type.value, [], depth + 1),
        constraints: extra,
      };

    case "unknown":
      return UNKNOWN;

    case "ref": {
      const decl = model.declFor(type.ref);
      if (decl === undefined) return UNKNOWN;
      return specOfDecl(model, decl, extra, depth + 1);
    }
  }
}

/** The spec for a declaration itself, without a reference to reach it through. */
export function specOfDecl(
  model: LinkedModel,
  decl: Decl,
  extra: readonly ConstraintIr[],
  depth: number,
): Spec {
  switch (decl.kind) {
    case "value":
      // The alias's own constraints sit *inside* the field's, so a field narrowing a
      // value is checked against both.
      return { ...specOf(model, decl.base, [...decl.constraints, ...extra], depth), named: decl.id.name };
    case "enum":
      return { shape: "enum", members: decl.members.map((m) => m.name), constraints: extra, named: decl.id.name };
    case "record":
    case "envelope":
    case "message":
      return {
        shape: "record",
        fields: flatFields(model, decl, depth),
        // An envelope declares none; a record and a message may (`02-contract.md` section 3).
        ...(decl.kind === "envelope" ? {} : { invariants: decl.invariants }),
        constraints: extra,
        named: decl.id.name,
      };
    default:
      return UNKNOWN;
  }
}

/** A record's own fields plus everything it `include`s, in declaration order. */
export function flatFields(model: LinkedModel, decl: Decl, depth = 0): FieldIr[] {
  if (depth > 16) return [];
  if (decl.kind !== "record" && decl.kind !== "envelope" && decl.kind !== "message") return [];

  const out: FieldIr[] = [];
  for (const inc of decl.includes) {
    const target = model.declFor(inc);
    if (target !== undefined) out.push(...flatFields(model, target, depth + 1));
  }
  // A field declared locally shadows an included one of the same name.
  const own = new Set(decl.fields.map((f) => f.name));
  return [...out.filter((f) => !own.has(f.name)), ...decl.fields];
}

/** The spec for one field: its type, carrying the field's own constraints. */
export const fieldSpec = (model: LinkedModel, field: FieldIr): Spec =>
  specOf(model, field.type, field.constraints);

// ---- constraint reading -----------------------------------------------------

export interface Bounds {
  readonly min?: number;
  readonly max?: number;
}

/** `length 1..32` / `range 0..` / `length 5` — `..` is one token in the IR's args. */
export function bounds(args: readonly string[]): Bounds {
  const i = args.indexOf("..");
  if (i < 0) {
    const only = Number(args[0]);
    return Number.isFinite(only) ? { min: only, max: only } : {};
  }
  const low = Number(args[i - 1]);
  const high = Number(args[i + 1]);
  return {
    ...(Number.isFinite(low) ? { min: low } : {}),
    ...(Number.isFinite(high) ? { max: high } : {}),
  };
}

const constraint = (spec: Spec, name: string): ConstraintIr | undefined =>
  // The last wins, which is the narrowing one: an alias's constraints come first.
  [...spec.constraints].reverse().find((c) => c.name === name);

const allOf = (spec: Spec, name: string): ConstraintIr[] =>
  spec.constraints.filter((c) => c.name === name);

/** Every declared `example`, unquoted. */
export function examples(spec: Spec): string[] {
  return allOf(spec, "example").flatMap((c) =>
    c.args.map((a) => (a.startsWith('"') ? (JSON.parse(a) as string) : a)),
  );
}

/** The narrowest `length`/`size` window across the alias chain. */
function window(spec: Spec, name: "length" | "size"): Bounds {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of allOf(spec, name)) {
    const b = bounds(c.args);
    if (b.min !== undefined && (min === undefined || b.min > min)) min = b.min;
    if (b.max !== undefined && (max === undefined || b.max < max)) max = b.max;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function range(spec: Spec): Bounds {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of allOf(spec, "range")) {
    const b = bounds(c.args);
    if (b.min !== undefined && (min === undefined || b.min > min)) min = b.min;
    if (b.max !== undefined && (max === undefined || b.max < max)) max = b.max;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

// ---- normalization ----------------------------------------------------------

/**
 * Applies `normalize` in the order written (`docs/spec/01-kernel.md` section 3), so
 * that equality means the same thing on both sides of a pipe.
 *
 * `nfc` is implicit on every string, so it happens whether or not it is declared.
 */
export function normalizeString(spec: Spec, text: string): string {
  let out = text.normalize("NFC");
  const ops = constraint(spec, "normalize")?.args ?? [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    switch (op) {
      case "trim":
        out = out.trim();
        break;
      case "collapseSpace":
        out = out.replace(/\s+/g, " ");
        break;
      case "upper":
        out = out.toUpperCase();
        break;
      case "lower":
        out = out.toLowerCase();
        break;
      case "nfkc":
        out = out.normalize("NFKC");
        break;
      case "strip": {
        // `strip(" -")` arrives as the operation followed by its string argument,
        // because the IR drops the parentheses as punctuation.
        const arg = ops[i + 1];
        if (arg !== undefined && arg.startsWith('"')) {
          const chars = JSON.parse(arg) as string;
          out = [...out].filter((c) => !chars.includes(c)).join("");
          i++;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Normalizes a whole value against its spec, recursing into records and lists. */
export function normalizeValue(model: LinkedModel, spec: Spec, value: JsonValue): JsonValue {
  if (value === undefined) return value;

  switch (spec.shape) {
    case "scalar":
      return spec.kernel === "string" && typeof value === "string"
        ? normalizeString(spec, value)
        : value;

    case "list": {
      if (!Array.isArray(value) || spec.item === undefined) return value;
      return value.map((v) => normalizeValue(model, spec.item!, v));
    }

    case "record": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const out: Record<string, JsonValue> = { ...(value as Record<string, JsonValue>) };
      for (const field of spec.fields ?? []) {
        if (out[field.name] === undefined) continue;
        out[field.name] = normalizeValue(model, fieldSpec(model, field), out[field.name]!);
      }
      return out;
    }

    default:
      return value;
  }
}

// ---- validation -------------------------------------------------------------

export interface Problem {
  readonly path: string;
  readonly message: string;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATION = /^(P|\d+(ms|s|m|h|d))/;

/**
 * What an invariant may read besides the value it is declared on.
 *
 * A bare path reads that value; `message.` reads the whole body it sits in, so an invariant on
 * a nested record can relate an element to the message around it; `envelope.` reads the envelope
 * (`10-grammar.md`'s clause table permits both).
 */
export interface Context {
  readonly root?: JsonValue;
  readonly envelope?: Readonly<Record<string, JsonValue>>;
}

export function validate(
  model: LinkedModel,
  spec: Spec,
  value: JsonValue,
  path = "",
  out: Problem[] = [],
  context: Context = {},
): Problem[] {
  const at = path === "" ? "(root)" : path;

  // There is no null in 7K, so a null in input is an error naming the field rather
  // than a silently absent value (`docs/spec/01-kernel.md` section 7.2).
  if (value === null) {
    out.push({ path: at, message: "null is never valid input; omit the key instead" });
    return out;
  }

  switch (spec.shape) {
    case "unknown":
      return out;

    case "enum":
      if (typeof value !== "string" || !(spec.members ?? []).includes(value)) {
        out.push({
          path: at,
          message: `expected one of ${(spec.members ?? []).join(", ")}, got ${JSON.stringify(value)}`,
        });
      }
      return out;

    case "list": {
      if (!Array.isArray(value)) {
        out.push({ path: at, message: `expected a list, got ${typeOf(value)}` });
        return out;
      }
      const size = window(spec, "size");
      if (size.min !== undefined && value.length < size.min) {
        out.push({ path: at, message: `size ${value.length} is below the declared minimum ${size.min}` });
      }
      if (size.max !== undefined && value.length > size.max) {
        out.push({ path: at, message: `size ${value.length} exceeds the declared maximum ${size.max}` });
      }
      if (allOf(spec, "unique").length > 0) {
        const seen = new Set(value.map((v) => JSON.stringify(v)));
        if (seen.size !== value.length) out.push({ path: at, message: "declared unique, but has duplicates" });
      }
      if (spec.item !== undefined) {
        value.forEach((v, i) => validate(model, spec.item!, v, `${path}[${i}]`, out, context));
      }
      return out;
    }

    case "record": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push({ path: at, message: `expected an object, got ${typeOf(value)}` });
        return out;
      }
      const object = value as Record<string, JsonValue>;
      const before = out.length;
      const declared = new Set<string>();
      for (const field of spec.fields ?? []) {
        declared.add(field.name);
        const sub = `${path === "" ? "" : `${path}.`}${field.name}`;
        const present = object[field.name];
        if (present === undefined) {
          if (!field.optional) out.push({ path: sub, message: "required field is absent" });
          continue;
        }
        validate(model, fieldSpec(model, field), present, sub, out, context);
      }
      for (const key of Object.keys(object)) {
        if (!declared.has(key)) out.push({ path: `${path === "" ? "" : `${path}.`}${key}`, message: "not a declared field" });
      }

      // Invariants last, and only when the fields themselves hold up: a rule over a value that
      // is already the wrong shape would report a second, derived failure for one cause.
      if (out.length === before) checkInvariants(spec, object, at, context ?? {}, out);
      return out;
    }

    case "map": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push({ path: at, message: `expected an object, got ${typeOf(value)}` });
        return out;
      }
      if (spec.value !== undefined) {
        for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
          validate(model, spec.value, v, `${path}.${k}`, out, context);
        }
      }
      return out;
    }

    case "scalar":
      return validateScalar(spec, value, at, out);
  }
}

/**
 * Evaluates a record's invariants against it.
 *
 * A predicate that reads a path with no value is reported as that, not as a rule that failed:
 * an absent operand makes a comparison false (by design), so a typo in a path would otherwise
 * look exactly like a contract genuinely broken, on every message forever.
 */
function checkInvariants(
  spec: Spec,
  object: Readonly<Record<string, JsonValue>>,
  at: string,
  context: Context,
  out: Problem[],
): void {
  for (const invariant of spec.invariants ?? []) {
    const missing = unreadable(invariant, object, context);
    if (missing !== undefined) {
      out.push({
        path: at,
        message: `the invariant \`${showPredicate(invariant)}\` reads \`${missing}\`, which has no value here`,
      });
      continue;
    }

    if (holds(invariant, object, context)) continue;
    out.push({ path: at, message: `the invariant \`${showPredicate(invariant)}\` does not hold` });
  }
}

/** A message-shaped view of a record, so one predicate evaluator serves every clause. */
const asMessage = (object: Readonly<Record<string, JsonValue>>, context: Context): Message => ({
  envelope: { id: "", type: "", time: 0, fields: context.envelope ?? {} },
  body: (context.root ?? object) as Readonly<Record<string, JsonValue>>,
  from: "",
  claims: {},
});

/**
 * Whether an invariant holds.
 *
 * A bare path reads the record it is declared on, which is not what `message.` reads when the
 * record is nested — so the two are evaluated against different roots.
 */
function holds(
  invariant: Predicate,
  object: Readonly<Record<string, JsonValue>>,
  context: Context,
): boolean {
  return evaluate(invariant, {
    ...asMessage(object, context),
    // `field` operands read the body, so the body *is* this record for a bare path.
    body: object,
  });
}

/** The first path an invariant reads that has no value, if any. */
function unreadable(
  invariant: Predicate,
  object: Readonly<Record<string, JsonValue>>,
  context: Context,
): string | undefined {
  for (const operand of operandsOf(invariant)) {
    if (operand.k === "literal" || operand.k === "list") continue;

    const root: JsonValue =
      operand.k === "envelope"
        ? ((context.envelope ?? {}) as JsonValue)
        : operand.k === "message"
          ? ((context.root ?? object) as JsonValue)
          : (object as JsonValue);

    if (operand.k === "claim") continue;

    const read = readPath(root, operand.path);
    // A projected path yields one entry per element, each of which may itself be absent — so
    // `lines[].unit.currncy` over two lines reads `[undefined, undefined]` rather than nothing
    // at all, and a length check would call that readable.
    const empty = Array.isArray(read)
      ? read.length === 0 || read.every((v) => v === undefined)
      : read === undefined;
    if (!empty) continue;

    const shown = `${operand.k === "field" ? "" : `${operand.k}.`}${operand.path.join(".")}`;
    return shown;
  }
  return undefined;
}

/** Every operand a predicate reads, flattened. */
function operandsOf(predicate: Predicate, out: Operand[] = []): Operand[] {
  switch (predicate.p) {
    case "and":
    case "or":
      for (const p of predicate.operands) operandsOf(p, out);
      return out;
    case "not":
      return operandsOf(predicate.operand, out);
    case "cmp":
      out.push(predicate.left, predicate.right);
      return out;
    case "unknown":
      return out;
  }
}

function validateScalar(spec: Spec, value: JsonValue, at: string, out: Problem[]): Problem[] {
  const push = (message: string): void => {
    out.push({ path: at, message });
  };

  switch (spec.kernel) {
    case "bool":
      if (typeof value !== "boolean") push(`expected a bool, got ${typeOf(value)}`);
      return out;

    case "string": {
      if (typeof value !== "string") {
        push(`expected a string, got ${typeOf(value)}`);
        return out;
      }
      const len = window(spec, "length");
      // Scalar values, not UTF-16 code units: a declared length counts characters.
      const count = [...value].length;
      if (len.min !== undefined && count < len.min) push(`length ${count} is below the declared minimum ${len.min}`);
      if (len.max !== undefined && count > len.max) push(`length ${count} exceeds the declared maximum ${len.max}`);
      const pattern = constraint(spec, "pattern");
      if (pattern !== undefined) {
        const re = compilePattern(pattern.args[0]);
        if (re !== undefined && !re.test(value)) push(`does not match ${pattern.args[0]}`);
      }
      return out;
    }

    case "uuid":
      if (typeof value !== "string" || !UUID.test(value)) push(`expected a uuid, got ${JSON.stringify(value)}`);
      return out;

    case "instant":
      if (typeof value !== "string" || !RFC3339.test(value)) {
        push(`expected an RFC 3339 instant, got ${JSON.stringify(value)}`);
      }
      return out;

    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        push(`expected a date, got ${JSON.stringify(value)}`);
      }
      return out;

    case "duration":
      if (typeof value !== "string" || !DURATION.test(value)) {
        push(`expected a duration, got ${JSON.stringify(value)}`);
      }
      return out;

    case "bytes":
      if (typeof value !== "string") push(`expected base64url bytes, got ${typeOf(value)}`);
      return out;

    case "decimal": {
      // A decimal travels as a string and must not round-trip through a double
      // (`docs/spec/01-kernel.md` section 7.1).
      if (typeof value !== "string") {
        push(`a decimal encodes as a string, got ${typeOf(value)}`);
        return out;
      }
      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        push(`expected a decimal, got ${JSON.stringify(value)}`);
        return out;
      }
      if (spec.scale !== undefined) {
        const fraction = value.split(".")[1] ?? "";
        if (fraction.length !== spec.scale) {
          push(`a decimal(${spec.precision ?? ""},${spec.scale}) is written with exactly ${spec.scale} fractional digits`);
        }
      }
      return numericBounds(spec, Number(value), push, out);
    }

    case "int":
      if (typeof value === "string" && /^-?\d+$/.test(value)) return numericBounds(spec, Number(value), push, out);
      if (typeof value !== "number" || !Number.isInteger(value)) {
        push(`expected an int, got ${typeOf(value)}`);
        return out;
      }
      return numericBounds(spec, value, push, out);

    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        push(`expected a finite float, got ${typeOf(value)}`);
        return out;
      }
      return numericBounds(spec, value, push, out);

    default:
      return out;
  }
}

function numericBounds(spec: Spec, n: number, push: (m: string) => void, out: Problem[]): Problem[] {
  const r = range(spec);
  if (r.min !== undefined && n < r.min) push(`${n} is below the declared minimum ${r.min}`);
  if (r.max !== undefined && n > r.max) push(`${n} exceeds the declared maximum ${r.max}`);
  const multiple = constraint(spec, "multipleof");
  const by = multiple === undefined ? undefined : Number(multiple.args[0]);
  if (by !== undefined && Number.isFinite(by) && by !== 0 && n % by !== 0) {
    push(`${n} is not a multiple of ${by}`);
  }
  return out;
}

const typeOf = (v: JsonValue): string =>
  v === undefined ? "nothing" : Array.isArray(v) ? "a list" : v === null ? "null" : `a ${typeof v}`;

/**
 * Compiles a declared pattern. A dialect 7K does not guarantee is simply not
 * enforced here rather than enforced wrongly — a sandbox that substituted its own
 * engine would be the exact failure mode `01-kernel.md` section 2.1 forbids.
 */
function compilePattern(text: string | undefined): RegExp | undefined {
  if (text === undefined) return undefined;
  const m = /^\/(.*)\/([a-z0-9]*)$/.exec(text);
  if (m === null) return undefined;
  try {
    return new RegExp(m[1]!);
  } catch {
    return undefined;
  }
}

// ---- generation -------------------------------------------------------------

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

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
      const size = window(spec, "size");
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
      const len = window(spec, "length");
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
    const size = window(spec, "size");
    return size.min !== undefined && size.min > 0 ? [] : Array.from({ length: (size.max ?? 1) + 1 }, () => "x");
  }
  if (spec.shape === "enum") return "NotAMember";

  switch (spec.kernel) {
    case "string": {
      const len = window(spec, "length");
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

  return value;
}

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
