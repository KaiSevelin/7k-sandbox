/**
 * Upcasts: translating an older message to the version a consumer understands.
 *
 * The specification says an `upcast` is declared in the model "so that generated code has one
 * canonical home for it and the sandbox can exercise it" (`02-contract.md` section 5.4). Until
 * now neither was true — Core resolved the declaration, dropped its body, and nothing applied
 * it. These are what makes the second half of that sentence stand up.
 */

import { describe, expect, it } from "vitest";
import { countOf, run } from "./harness.js";

const MODEL = `
package t

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
  tenantId:      Ref  @role(partitionKey)
  actor:         Ref  @role(subject)
}

envelopes Meta

value Ref : string { length 1..16 }

message Order v2.0 @command {
  k:       Ref  @role(businessKey)
  note:    Ref? @since(1.1)
  channel: Ref  @since(2.0)
}

upcast Order v1.0 to v1.1 {
  note = absent
}

upcast Order v1.1 to v2.0 {
  channel = "legacy"
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

/** The body a consumer actually handled, read off the trace's delivery. */
const handledBody = (result: Awaited<ReturnType<typeof run>>): unknown => {
  const upcast = result.trace.of("upcast").at(-1);
  if (upcast !== undefined) return upcast.body;
  return result.trace.of("published").at(-1)?.body;
};

describe("a message at the current version", () => {
  it("is not translated at all", async () => {
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order as Caller { k: "A", channel: "web" }
  advance 1s
  expect Worker handled Order count 1`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "upcast")).toBe(0);
  });
});

describe("an older message", () => {
  it("is translated through every step of the chain", async () => {
    // v1.0 has neither `note` nor `channel`, so sending it is only possible by pinning the
    // version — which is also the only way an upcast gets exercised.
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order v1.0 as Caller { k: "A" }
  advance 1s
  expect Worker handled Order count 1`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("upcast")[0]?.detail).toBe("v1.0 to v1.1 to v2.0");
  });

  it("arrives in the shape the consumer's contract describes", async () => {
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order v1.0 as Caller { k: "A" }
  advance 1s`),
    );

    // `note = absent` leaves the key out, because there is no null in 7K; `channel = "legacy"`
    // supplies the required field 1.2 added.
    expect(handledBody(result)).toEqual({ k: "A", channel: "legacy" });
  });

  it("would be rejected without the translation, which is the point", async () => {
    // The same send with the chain broken: `channel` is required at v2.0 and nothing supplies it.
    const broken = MODEL.replace('upcast Order v1.1 to v2.0 {\n  channel = "legacy"\n}\n', "");
    expect(broken).not.toBe(MODEL);
    const result = await run(
      broken,
      scenario(`  at 0s publish Order v1.0 as Caller { k: "A" }
  advance 1s
  expect Order on commands.dead`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("rejected")[0]?.detail).toContain("channel");
    expect(result.notes.join(" ")).toMatch(/no `upcast Order v1\.1 to \.\.\.` is declared/);
  });

  it("starts partway along the chain when that is where it joined", async () => {
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order v1.1 as Caller { k: "A", note: "hi" }
  advance 1s`),
    );

    expect(result.trace.of("upcast")[0]?.detail).toBe("v1.1 to v2.0");
    // `note` survives, because only the step that needed it assigns anything.
    expect(handledBody(result)).toEqual({ k: "A", note: "hi", channel: "legacy" });
  });

  it("validates the pinned version's own shape before sending it", async () => {
    // `channel` does not exist at v1.0, so naming it is a field the message did not have.
    const result = await run(
      MODEL,
      scenario(`  at 0s publish Order v1.0 as Caller { k: "A", channel: "web" }
  advance 1s`),
    );

    expect(result.status).toBe("fail");
    expect(result.errors.join(" ")).toContain("channel");
  });
});

describe("reading a field across a version", () => {
  it("copies from the shape before the step, so a rename works in one assignment", async () => {
    const renamed = `
package t

value Ref : string { length 1..16 }

message Order v2.0 @command {
  k:     Ref @role(businessKey)
  buyer: Ref @since(2.0)
}

upcast Order v1.0 to v2.0 {
  buyer = customer
}

pipe commands : queue

service Caller @external {
  emits Order to commands
}

service Worker {
  reacts Order from commands { replies none }
}
`;
    // At v1.0 the field was called `customer`; the model no longer declares it, so the send is
    // `unchecked` — which is what sending a shape the current contract has forgotten requires.
    const result = await run(
      renamed,
      scenario(`  at 0s publish Order v1.0 as Caller unchecked { k: "A", customer: "C-1" }
  advance 1s`),
    );

    expect(result.trace.of("upcast")[0]?.body).toEqual({ k: "A", customer: "C-1", buyer: "C-1" });
  });
});
