/**
 * Generation, normalization and validation.
 *
 * The property that matters most is the round trip: **anything the generator produces
 * must satisfy the validator.** A `$auto` that produced values its own checker
 * rejected would make every fixture in every scenario a lie, and it is the exact
 * failure the two sharing one resolved type exists to prevent.
 */

import { buildWorkspace, readJsonBody, type LinkedModel, type MessageIr } from "@sevenk/core";
import { describe, expect, it } from "vitest";
import { Rng } from "../src/clock.js";
import {
  generate,
  invalid,
  normalizeString,
  prepareBody,
  specOfDecl,
  validate,
  type Spec,
} from "../src/schema.js";

const MODEL = `
package t

value Code  : string { length 2; normalize upper }
value Short : string { length 1..8 }
value Price : decimal(18,2) { range 0.. }
value Qty   : int { range 1..99 }
value Tag   : string { length 1..5; pattern /^[A-Z]{2}-[0-9]{2}$/; example "AB-12" }

enum Colour { Red Green Blue }

record Line {
  sku:   Short
  qty:   Qty
  price: Price
}

message Order v1.0 @command {
  id:     uuid @role(businessKey)
  code:   Code
  lines:  [Line] { size 1..4; unique }
  colour: Colour
  note:   Short?
}

message Tagged v1.0 @event {
  id:  uuid @role(businessKey)
  tag: Tag
}

// A float beside a decimal, because a scenario writes both the same way and they mean different
// things. The block near the bottom of this file is about exactly that.
message Weighed v1.0 @event {
  id:     uuid @role(businessKey)
  weight: float
  price:  Price
}
`;

function load(): { model: LinkedModel; order: MessageIr; tagged: MessageIr; weighed: MessageIr } {
  const workspace = buildWorkspace([{ path: "m.7k", source: MODEL }]);
  expect(workspace.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const find = (name: string): MessageIr => {
    const decl = workspace.model.decls.find((d) => d.kind === "message" && d.id.name === name);
    if (decl === undefined || decl.kind !== "message") throw new Error(name);
    return decl;
  };
  return {
    model: workspace.model,
    order: find("Order"),
    tagged: find("Tagged"),
    weighed: find("Weighed"),
  };
}

describe("generation", () => {
  it("produces values its own validator accepts, for every seed", () => {
    const { model, order } = load();
    const spec = specOfDecl(model, order, [], 0);

    for (let seed = 0; seed < 50; seed++) {
      const value = generate(model, spec, new Rng(seed), 0);
      expect(validate(model, spec, value), `seed ${seed}`).toEqual([]);
    }
  });

  it("satisfies a pattern by using the declared example, since it cannot invert one", () => {
    const { model, tagged } = load();
    const spec = specOfDecl(model, tagged, [], 0);
    for (let seed = 0; seed < 10; seed++) {
      const value = generate(model, spec, new Rng(seed), 0) as Record<string, unknown>;
      expect(value.tag).toBe("AB-12");
    }
  });

  it("leaves an optional field out, because absent is absent", () => {
    const { model, order } = load();
    const value = generate(model, specOfDecl(model, order, [], 0), new Rng(1), 0) as Record<
      string,
      unknown
    >;
    expect("note" in value).toBe(false);
  });

  it("draws a unique list, so a `unique` constraint is satisfiable by generation", () => {
    const { model, order } = load();
    for (let seed = 0; seed < 30; seed++) {
      const value = generate(model, specOfDecl(model, order, [], 0), new Rng(seed), 0) as {
        lines: unknown[];
      };
      expect(new Set(value.lines.map((l) => JSON.stringify(l))).size).toBe(value.lines.length);
    }
  });
});

describe("validation", () => {
  const problems = (body: Record<string, unknown>): string[] => {
    const { model, order } = load();
    return validate(model, specOfDecl(model, order, [], 0), body as never).map(
      (p) => `${p.path}: ${p.message}`,
    );
  };

  const valid = {
    id: "00000000-0000-7000-8000-000000000000",
    code: "SE",
    lines: [{ sku: "A1", qty: 2, price: "19.99" }],
    colour: "Red",
  };

  it("accepts a valid body", () => {
    expect(problems(valid)).toEqual([]);
  });

  it("names a missing required field", () => {
    const { colour, ...rest } = valid;
    void colour;
    expect(problems(rest)).toEqual(["colour: required field is absent"]);
  });

  it("names a field that is not declared, rather than ignoring it", () => {
    expect(problems({ ...valid, extra: 1 })).toEqual(["extra: not a declared field"]);
  });

  it("rejects null outright, because there is no null in 7K", () => {
    expect(problems({ ...valid, code: null })).toEqual([
      "code: null is never valid input; omit the key instead",
    ]);
  });

  it("reports a decimal written as a number, which must not pass through a double", () => {
    expect(problems({ ...valid, lines: [{ sku: "A1", qty: 2, price: 19.99 }] })).toEqual([
      "lines[0].price: a decimal encodes as a string, got a number",
    ]);
  });

  it("requires a decimal to carry exactly its declared scale", () => {
    expect(problems({ ...valid, lines: [{ sku: "A1", qty: 2, price: "19.9" }] })).toEqual([
      "lines[0].price: a decimal(18,2) is written with exactly 2 fractional digits",
    ]);
  });

  it("enforces a range on an int", () => {
    expect(problems({ ...valid, lines: [{ sku: "A1", qty: 0, price: "1.00" }] })).toEqual([
      "lines[0].qty: 0 is below the declared minimum 1",
    ]);
  });

  it("enforces the narrowest length across an alias chain", () => {
    expect(problems({ ...valid, code: "SWE" })).toEqual([
      "code: length 3 exceeds the declared maximum 2",
    ]);
  });

  it("enforces size and uniqueness on a list", () => {
    const line = { sku: "A1", qty: 1, price: "1.00" };
    expect(problems({ ...valid, lines: [] })).toEqual([
      "lines: size 0 is below the declared minimum 1",
    ]);
    expect(problems({ ...valid, lines: [line, line] })).toEqual([
      "lines: declared unique, but has duplicates",
    ]);
  });

  it("names the enum members it expected", () => {
    expect(problems({ ...valid, colour: "Purple" })).toEqual([
      'colour: expected one of Red, Green, Blue, got "Purple"',
    ]);
  });
});

describe("normalization", () => {
  const spec = (ops: string[]): Spec => ({
    shape: "scalar",
    kernel: "string",
    constraints: [{ name: "normalize", args: ops, span: { file: "", start: 0, end: 0 } }],
  });

  it("applies operations in the order written", () => {
    expect(normalizeString(spec(["trim", "upper"]), "  se  ")).toBe("SE");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeString(spec(["collapseSpace"]), "a   b\tc")).toBe("a b c");
  });

  it("reads a strip argument through the parentheses the IR drops", () => {
    expect(normalizeString(spec(["strip", '" -"', "upper"]), "12 34-56")).toBe("123456");
  });

  it("normalizes before validating, so a declared form is what gets checked", () => {
    const { model, order } = load();
    const result = prepareBody(
      model,
      order,
      {
        id: "00000000-0000-7000-8000-000000000000",
        code: "se",
        lines: [{ sku: "A1", qty: 1, price: "1.00" }],
        colour: "Red",
      },
      new Rng(1),
      0,
    );
    expect(result.problems).toEqual([]);
    expect(result.body.code).toBe("SE");
  });
});

/**
 * A number literal in a scenario body means different things in different fields.
 *
 * `1.5` lowers to the string `"1.5"`, because a `decimal` must never round-trip through a double
 * (`01-kernel.md` 7.1) and the lexer cannot know which kernel the field is. A `float` is a JSON
 * number, so the string was refused — and a scenario had no way at all to write a `float` field with
 * a fractional part. The field's type is in hand when the written body is resolved against it, which
 * is where it is now decided.
 */
describe("a decimal literal against a float field", () => {
  const body = (weight: unknown): Record<string, unknown> => ({
    id: "00000000-0000-7000-8000-000000000000",
    weight,
    price: "1.00",
  });

  it("is what the language lowers a fractional literal to", () => {
    // The premise, asserted rather than assumed: this is the value a scenario's `weight: 1.5`
    // actually becomes, and the reason the rest of this block exists.
    const written = readJsonBody("{ weight: 1.5, price: 2.50 }");
    expect(written).toEqual({ value: { weight: "1.5", price: "2.50" } });
  });

  it("is read as a number, so a scenario can write a float at all", () => {
    const { model, weighed } = load();
    const result = prepareBody(model, weighed, body("1.5"), new Rng(1), 0);
    expect(result.problems).toEqual([]);
    expect(result.body.weight).toBe(1.5);
  });

  it("leaves a decimal field as the string it is, which is why the string is there", () => {
    const { model, weighed } = load();
    const result = prepareBody(model, weighed, body("1.5"), new Rng(1), 0);
    expect(result.problems).toEqual([]);
    expect(result.body.price).toBe("1.00");
  });

  it("still refuses a string that is not a number", () => {
    const { model, weighed } = load();
    const result = prepareBody(model, weighed, body("heavy"), new Rng(1), 0);
    expect(result.problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      "weight: expected a finite float, got a string",
    ]);
  });
});

describe("$invalid", () => {
  it("violates the constraint it was asked to break", () => {
    const { model, order } = load();
    const spec = specOfDecl(model, order, [], 0);
    const broken = invalid({ shape: "scalar", kernel: "string", constraints: spec.constraints }, "length");
    expect(typeof broken).toBe("string");
    expect((broken as string).length).toBeGreaterThan(32);
  });

  it("empties a list whose size has a lower bound", () => {
    const { model, order } = load();
    const lines = specOfDecl(model, order, [], 0).fields?.find((f) => f.name === "lines");
    expect(lines).toBeDefined();
    expect(invalid({ shape: "list", constraints: lines!.constraints }, "size")).toEqual([]);
  });
});
