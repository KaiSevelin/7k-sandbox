/**
 * Evaluating a predicate against a message.
 *
 * The rule worth pinning down is what an **absent** operand does. A comparison needs
 * two values, so one with a missing side is false — including `!=`, because "absent
 * differs from absent" is as unfounded as "absent equals absent". It matters most in
 * the place it is least visible: `requires claim.tid == envelope.tenantId` must not
 * hold because a sender presented neither.
 */

import { describe, expect, it } from "vitest";
import type { Predicate } from "@sevenk/core";
import { evaluate, readPath, type Message } from "../src/message.js";

const message = (
  body: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
  claims: Record<string, unknown> = {},
): Message => ({
  envelope: { id: "i", type: "t.M", time: 0, fields: envelope as never },
  body: body as never,
  from: "X",
  claims: claims as never,
});

const cmp = (left: Predicate extends never ? never : object, op: string, right: object): Predicate =>
  ({ p: "cmp", op, left, right, span: { file: "", start: 0, end: 0 } }) as Predicate;

const claim = (name: string) => ({ k: "claim", name }) as const;
const envelope = (...path: string[]) => ({ k: "envelope", path }) as const;
const field = (...path: string[]) => ({ k: "message", path }) as const;
const literal = (value: unknown) => ({ k: "literal", value }) as const;

describe("absent operands", () => {
  it("makes a comparison false rather than true when both sides are missing", () => {
    const m = message({});
    expect(evaluate(cmp(claim("tid"), "==", envelope("tenantId")), m)).toBe(false);
    expect(evaluate(cmp(claim("tid"), "!=", envelope("tenantId")), m)).toBe(false);
  });

  it("makes a comparison false when only one side is missing", () => {
    const m = message({}, {}, { tid: "acme" });
    expect(evaluate(cmp(claim("tid"), "==", envelope("tenantId")), m)).toBe(false);
    expect(evaluate(cmp(claim("tid"), "!=", envelope("tenantId")), m)).toBe(false);
  });

  it("compares two present values normally", () => {
    const m = message({}, { tenantId: "acme" }, { tid: "acme" });
    expect(evaluate(cmp(claim("tid"), "==", envelope("tenantId")), m)).toBe(true);

    const other = message({}, { tenantId: "other" }, { tid: "acme" });
    expect(evaluate(cmp(claim("tid"), "==", envelope("tenantId")), other)).toBe(false);
    expect(evaluate(cmp(claim("tid"), "!=", envelope("tenantId")), other)).toBe(true);
  });

  it("never throws on a predicate it cannot evaluate", () => {
    const m = message({ a: 1 });
    expect(evaluate({ p: "unknown", text: "?", span: { file: "", start: 0, end: 0 } }, m)).toBe(false);
    expect(evaluate(cmp(field("a", "b", "c"), ">", literal(1)), m)).toBe(false);
  });
});

describe("decimals", () => {
  it("treats a decimal string and a number as the same value", () => {
    const m = message({ total: "19.99" });
    expect(evaluate(cmp(field("total"), "==", literal(19.99)), m)).toBe(true);
    expect(evaluate(cmp(field("total"), ">", literal(10)), m)).toBe(true);
  });
});

describe("projections", () => {
  it("means `for every element`, so it holds only when every one holds", () => {
    const m = message({ lines: [{ qty: 2 }, { qty: 3 }] });
    expect(evaluate(cmp(field("lines", "[]", "qty"), ">", literal(1)), m)).toBe(true);
    expect(evaluate(cmp(field("lines", "[]", "qty"), ">", literal(2)), m)).toBe(false);
  });

  it("reads a list's length through `.size`", () => {
    expect(readPath({ seats: [1, 2, 3] } as never, ["seats", "size"])).toBe(3);
  });

  it("is false over an empty list, since there is nothing to hold of", () => {
    const m = message({ lines: [] });
    expect(evaluate(cmp(field("lines", "[]", "qty"), ">", literal(0)), m)).toBe(false);
  });
});

describe("contains", () => {
  it("reads a space-separated scope claim as a set of scopes", () => {
    const m = message({}, {}, { scope: "orders.write ticketing.write" });
    expect(evaluate(cmp(claim("scope"), "contains", literal("ticketing.write")), m)).toBe(true);
    // A prefix is not a scope: `ticketing` must not satisfy `ticketing.write`.
    expect(evaluate(cmp(claim("scope"), "contains", literal("ticketing")), m)).toBe(false);
  });

  it("reads a list membership", () => {
    const m = message({ tags: ["a", "b"] });
    expect(evaluate(cmp(field("tags"), "contains", literal("b")), m)).toBe(true);
    expect(evaluate(cmp(field("tags"), "contains", literal("c")), m)).toBe(false);
  });
});
