/**
 * Invariants: contract rules over a message's or a record's own data.
 *
 * They were parsed and dropped — the predicate read, the IR with nowhere to put it, and so a
 * declared rule enforced by nothing. These pin what enforcing one means, and in particular that
 * a projection distributes from **either** side of a comparison, which is where the first
 * implementation was wrong.
 */

import { describe, expect, it } from "vitest";
import { countOf, run } from "./harness.js";

const MODEL = `
package t

value Code : string { length 3; normalize upper }
value Ref  : string { length 1..16 }

record Money {
  amount:   decimal(18,2) { range 0.. }
  currency: Code
}

record Line {
  sku:   Ref
  unit:  Money
  total: Money

  // Within one line: the two amounts are in the same currency.
  invariant total.currency == unit.currency
}

message Order v1.0 @command {
  k:     Ref @role(businessKey)
  lines: [Line] { size 1..4 }
  total: Money

  // Across the message: every line agrees with the order's currency.
  invariant total.currency == lines[].unit.currency
}

pipe commands : queue

service Caller @external {
  emits Order to commands
}

service Worker {
  reacts Order from commands { replies none }
}
`;

const scenario = (body: string): string => `scenarios for t\n\nscenario S {\n  seed 1\n${body}\n}\n`;

/** One line, with both amounts in the given currencies. */
const line = (unit: string, total = unit): string =>
  `{ sku: "A", unit: { amount: "10.00", currency: "${unit}" }, ` +
  `total: { amount: "10.00", currency: "${total}" } }`;

const order = (lines: string, total: string): string =>
  `  at 0s publish Order as Caller { k: "K-1", lines: [${lines}], ` +
  `total: { amount: "10.00", currency: "${total}" } }`;

describe("an invariant that holds", () => {
  it("lets the message through", async () => {
    const result = await run(
      MODEL,
      scenario(`${order(line("SEK"), "SEK")}
  advance 1s
  expect Worker handled Order count 1`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "rejected")).toBe(0);
  });

  it("holds across every element of a projection", async () => {
    const result = await run(
      MODEL,
      scenario(`${order(`${line("SEK")}, ${line("SEK")}`, "SEK")}
  advance 1s
  expect Worker handled Order count 1`),
    );

    expect(result.status).toBe("pass");
  });
});

describe("an invariant that does not", () => {
  it("is refused by the composer, naming the rule", async () => {
    const result = await run(
      MODEL,
      scenario(`${order(line("SEK"), "NOK")}
  advance 1s`),
    );

    expect(result.status).toBe("fail");
    expect(result.errors.join(" ")).toContain("total.currency == lines.[].unit.currency");
  });

  it("distributes the projection from the right-hand side", async () => {
    // The order agrees with the first line and not the second. Until the evaluator distributed
    // a projection on the right, this passed — and so did a message with no agreement at all.
    const result = await run(
      MODEL,
      scenario(`${order(`${line("SEK")}, ${line("NOK")}`, "SEK")}
  advance 1s`),
    );

    expect(result.status).toBe("fail");
    expect(result.errors.join(" ")).toContain("does not hold");
  });

  it("is rejected by the consumer when the composer was told not to look", async () => {
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order as Caller unchecked { k: "K-1", lines: [${line("SEK")}], total: { amount: "10.00", currency: "NOK" } }
  advance 1s
  expect Order on commands.dead`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("rejected")[0]?.detail).toContain("does not hold");
  });
});

describe("an invariant on a nested record", () => {
  it("is checked for each element, naming which", async () => {
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order as Caller unchecked { k: "K-1", lines: [${line("SEK")}, ${line("SEK", "NOK")}], total: { amount: "10.00", currency: "SEK" } }
  advance 1s`),
    );

    // The second line's own rule is broken; the message-level one still holds.
    expect(result.trace.of("rejected")[0]?.detail).toContain("lines[1]");
    expect(result.trace.of("rejected")[0]?.detail).toContain("total.currency == unit.currency");
  });
});

describe("a path that reads nothing", () => {
  it("says so rather than reporting a rule that failed", async () => {
    // An absent operand makes a comparison false by design, so a typo in a path would otherwise
    // look exactly like a contract genuinely broken — on every message, forever.
    const typo = MODEL.replace(
      "  invariant total.currency == lines[].unit.currency",
      "  invariant total.currency == lines[].unit.currncy",
    );
    const result = await run(
      typo,
      scenario(`${order(line("SEK"), "SEK")}
  advance 1s`),
    );

    expect(result.errors.join(" ")).toContain("has no value here");
    expect(result.errors.join(" ")).toContain("currncy");
  });
});

describe("generation and invariants", () => {
  it("cannot satisfy one, which is why a fixture writes the related fields", async () => {
    // `$auto` generates each field independently and has no way to honour a relation between
    // two of them. The composer refusing the result is the honest outcome.
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order as Caller { k: "K-1", lines: { $repeat: 2, of: "$auto" }, total: "$auto" }
  advance 1s`),
    );

    expect(result.status).toBe("fail");
    expect(result.errors.join(" ")).toContain("invariant");
  });
});
