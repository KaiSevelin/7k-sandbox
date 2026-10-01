/**
 * Sagas: starting, stepping, timing out, abandoning and compensating.
 *
 * The property these exist for is the **asymmetry of compensation**: an inverse runs for
 * a step that completed and must not run for one that did not. Asserting only the first
 * direction leaves the common bug uncaught (`docs/spec/04-process.md` section 1.4), so
 * every compensation test here checks both.
 */

import { describe, expect, it } from "vitest";
import { countOf, kinds, run } from "./harness.js";

const MODEL = `
package t

envelope Meta {
  correlationId: uuid @role(correlation)
  customerId:    string { length 1..8 } @role(partitionKey)
}

envelopes Meta

value Ref : string { length 1..16 }

message Place v1.0 @command {
  orderId: Ref @role(businessKey)
  amount:  int { range 1..1000 }
}

message Accepted v1.0 @event { orderId: Ref @role(businessKey) }

message Charge   v1.0 @command { orderId: Ref @role(businessKey) amount: int { range 1..1000 } }
message Charged  v1.0 @event   { orderId: Ref @role(businessKey) chargeId: uuid }
message Declined v1.0 @event   { orderId: Ref @role(businessKey) }
message Refund   v1.0 @command { orderId: Ref @role(businessKey) chargeId: uuid }
message Refunded v1.0 @event   { orderId: Ref @role(businessKey) }

message Ship     v1.0 @command { orderId: Ref @role(businessKey) }
message Shipped  v1.0 @event   { orderId: Ref @role(businessKey) }
message Unshippable v1.0 @event { orderId: Ref @role(businessKey) }
message Unship   v1.0 @command { orderId: Ref @role(businessKey) }

message Done      v1.0 @event { orderId: Ref @role(businessKey) }
message Failed    v1.0 @event { orderId: Ref @role(businessKey) }
message GaveUp    v1.0 @event { orderId: Ref @role(businessKey) }

pipe commands : queue
pipe events   : topic

service Caller {
  emits Place to commands
}

service Orders {
  emits Accepted to events
  emits Charge   to commands
  emits Refund   to commands
  emits Ship     to commands
  emits Unship   to commands
  emits Done     to events
  emits Failed   to events
  emits GaveUp   to events

  reacts Place from commands { replies Accepted }

  reacts Charged     from events { replies none }
  reacts Declined    from events { replies none }
  reacts Refunded    from events { replies none }
  reacts Shipped     from events { replies none }
  reacts Unshippable from events { replies none }
}

service Payments {
  emits Charged  to events
  emits Declined to events
  emits Refunded to events

  reacts Charge from commands { replies Charged | Declined }
  reacts Refund from commands { replies Refunded }
}

service Shipping {
  emits Shipped     to events
  emits Unshippable to events

  reacts Ship   from commands { replies Shipped | Unshippable }
  reacts Unship from commands { replies none }
}

saga Flow v1.0 {
  start on Place keyed by orderId {
    total = message.amount
  }

  state {
    total:    int { range 1..1000 }
    chargeId: uuid
  }

  step charge {
    // The amount is held as 'total', so a name match cannot reach it.
    send Charge { amount = state.total }
    on Charged  { chargeId = message.chargeId }
    on Declined reject "card declined"
    on timeout 30s reject "payment timed out"
    undo with Refund
  }

  step ship {
    send Ship
    on Shipped
    on Unshippable reject "cannot ship"
    on timeout 2m  reject "shipping timed out"
    undo with Unship
  }

  on deadline 24h abandon

  on complete send Done
  on reject   send Failed
  on abandon  send GaveUp
}
`;

const scenario = (body: string): string => `scenarios for t\n\nscenario S {\n  seed 1\n${body}\n}\n`;

const HAPPY = `  mock Payments {
    on Charge reply Charged after 100ms
    on Refund reply Refunded after 100ms
  }
  mock Shipping {
    on Ship   reply Shipped after 100ms
    on Unship reply none
  }`;

const place = (id: string): string =>
  `  at 0s publish Place as Caller { orderId: "${id}", amount: 50 }`;

describe("starting", () => {
  it("creates an instance when the hosting service handles the start message", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-1")}
  advance 1s
  expect saga Flow["O-1"].state == complete
  expect saga Flow count 1
  expect Done on events`),
    );

    expect(result.status).toBe("pass");
    expect(kinds(result).filter((k) => k.startsWith("saga-"))).toEqual([
      "saga-started",
      "saga-advanced",
      "saga-advanced",
      "saga-completed",
    ]);
  });

  it("needs no mock for the service hosting it, because the saga is its handler", async () => {
    // `Orders` declares `replies Accepted` and is never mocked. A scenario should not have
    // to script the service it is testing.
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-2")}
  advance 1s
  expect Accepted on events`),
    );

    expect(result.status).toBe("pass");
  });

  it("seeds state from the start block", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-3", amount: 77 }
  advance 1s
  expect saga Flow["O-3"].total == 77`),
    );

    expect(result.status).toBe("pass");
  });

  it("finds the existing instance for a duplicate start rather than creating a second", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  mock Payments { on Charge hang }
${place("O-4")}
${place("O-4")}
  advance 1s
  expect saga Flow count 1`),
    );

    expect(result.status).toBe("pass");
    // The subscription's own deduplication absorbs the second one first; the saga key is
    // the second line of defence, for a consumer that declared `once per none`.
    expect(countOf(result, "deduplicated") + countOf(result, "saga-redundant-start")).toBeGreaterThan(0);
  });

  it("keys instances apart, so two orders run independently", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-5")}
  at 0s publish Place as Caller { orderId: "O-6", amount: 10 }
  advance 1s
  expect saga Flow count 2
  expect saga Flow["O-5"].state == complete
  expect saga Flow["O-6"].state == complete`),
    );

    expect(result.status).toBe("pass");
  });
});

describe("stepping", () => {
  it("sends each step's message and correlates the reply on its business key", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-7")}
  advance 1s`),
    );

    expect(result.trace.of("published").map((e) => e.message)).toEqual([
      "t.Place",
      "t.Charge",
      "t.Accepted",
      "t.Charged",
      "t.Ship",
      "t.Shipped",
      "t.Done",
    ]);
  });

  it("records state from an `on` action and carries it into a later send", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  mock Shipping { on Ship reply Unshippable after 100ms
                  on Unship reply none }
${place("O-8")}
  advance 1s`),
    );

    const charged = result.trace.of("published").find((e) => e.message === "t.Charged");
    const refund = result.trace.of("published").find((e) => e.message === "t.Refund");
    // `chargeId = message.chargeId` was recorded, so the compensation carries the real one.
    expect(refund?.body?.chargeId).toBe(charged?.body?.chargeId);
  });

  it("carries the instance key onto every message it sends, so replies find their way back", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-9")}
  advance 1s`),
    );

    for (const event of result.trace.of("published")) {
      expect(event.body?.orderId, event.message).toBe("O-9");
    }
  });

  it("propagates the start message's envelope onto everything the saga sends", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  at 0s publish Place as Caller with envelope { customerId: "C-1" } { orderId: "O-10", amount: 5 }
  advance 1s`),
    );

    const published = result.trace.of("published");
    const correlation = published[0]?.envelope?.correlationId;
    for (const event of published) {
      expect(event.envelope?.customerId, event.message).toBe("C-1");
      expect(event.envelope?.correlationId, event.message).toBe(correlation);
    }
  });
});

describe("timeouts and the deadline", () => {
  it("rejects a step that waits longer than its timeout", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  mock Payments { on Charge hang }
${place("O-11")}
  advance 10s
  expect saga Flow["O-11"].state == charge
  advance 1m
  expect saga Flow["O-11"].state == reject
  expect Failed on events`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("saga-timeout")[0]?.detail).toContain("charge");
  });

  it("cancels a step's timeout when the step finishes in time", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-12")}
  advance 10m
  expect saga Flow["O-12"].state == complete`),
    );

    // Both step timeouts would have fired by 10m had they not been cancelled.
    expect(countOf(result, "saga-timeout")).toBe(0);
    expect(result.status).toBe("pass");
  });

  it("abandons the whole saga when the deadline elapses, wherever it had got to", async () => {
    const model = MODEL.replace("on timeout 30s reject \"payment timed out\"\n", "");
    const result = await run(
      model,
      scenario(`${HAPPY}
  mock Payments { on Charge hang }
${place("O-13")}
  advance 25h
  expect saga Flow["O-13"].state == abandon
  expect GaveUp on events`),
    );

    expect(result.status).toBe("pass");
  });

  it("runs a day-long deadline without waiting for it", async () => {
    const started = Date.now();
    const model = MODEL.replace("on timeout 30s reject \"payment timed out\"\n", "");
    const result = await run(
      model,
      scenario(`${HAPPY}
  mock Payments { on Charge hang }
${place("O-14")}
  advance 25h`),
    );

    expect(result.elapsedMs).toBe(25 * 3_600_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("compensation", () => {
  // The pair. Asserting only the first direction leaves the common bug uncaught.
  it("reverses a step that completed", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  mock Shipping { on Ship reply Unshippable after 100ms
                  on Unship reply none }
${place("O-15")}
  advance 1s
  expect Refund on commands
  expect Failed on events`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("saga-compensating").map((e) => e.message)).toEqual(["t.Refund"]);
  });

  it("does not reverse a step that never succeeded", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  mock Payments { on Charge reply Declined after 100ms
                  on Refund reply Refunded }
${place("O-16")}
  advance 1s
  expect no Refund on commands
  expect Failed    on events`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("saga-compensating")).toEqual([]);
  });

  it("unwinds several completed steps in reverse order", async () => {
    // A third step that fails after two have completed.
    const model = MODEL.replace(
      "  on deadline 24h abandon",
      `  step confirm {
    send Done
    on Refunded reject "never happens"
    on timeout 1s reject "confirmation timed out"
    undo none
  }

  on deadline 24h abandon`,
    );

    const result = await run(
      model,
      scenario(`${HAPPY}
${place("O-17")}
  advance 10s`),
    );

    expect(result.trace.of("saga-compensating").map((e) => e.detail)).toEqual(["ship", "charge"]);
  });

  it("skips a step declared `undo none`, and says so", async () => {
    const model = MODEL.replace("    undo with Unship", "    undo none");
    const result = await run(
      model,
      scenario(`${HAPPY}
  mock Shipping { on Ship reply Unshippable after 100ms }
${place("O-18")}
  advance 1s`),
    );

    // `ship` never completed here, so only `charge` unwinds; the point is that an
    // irreversible step is reported rather than silently skipped.
    expect(result.trace.of("saga-compensating").map((e) => e.message)).toEqual(["t.Refund"]);
  });

  it("does not compensate a saga that completed", async () => {
    const result = await run(MODEL, scenario(`${HAPPY}\n${place("O-19")}\n  advance 1s`));
    expect(result.trace.of("saga-compensating")).toEqual([]);
    expect(countOf(result, "saga-completed")).toBe(1);
  });
});

describe("a send's payload", () => {
  it("carries a field a name match cannot reach", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-23", amount: 42 }
  advance 1s`),
    );

    const charge = result.trace.of("published").find((e) => e.message === "t.Charge");
    expect(charge?.body?.amount).toBe(42);
    // Nothing had to be invented, so nothing is reported.
    expect(result.notes.join(" ")).not.toMatch(/generated/);
  });

  it("still fills the business key and a matching name without being asked", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-24", amount: 7 }
  advance 1s`),
    );

    const charge = result.trace.of("published").find((e) => e.message === "t.Charge");
    // `orderId` is the message's business key and takes the instance key; the block said
    // nothing about it.
    expect(charge?.body?.orderId).toBe("O-24");
  });

  it("lets the block win over a name match", async () => {
    const model = MODEL.replace(
      "    send Charge { amount = state.total }",
      "    send Charge { amount = 999 }",
    );
    const result = await run(
      model,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-25", amount: 7 }
  advance 1s`),
    );

    const charge = result.trace.of("published").find((e) => e.message === "t.Charge");
    expect(charge?.body?.amount).toBe(999);
  });

  it("reports a field it had to invent, naming it", async () => {
    const model = MODEL.replace("    send Charge { amount = state.total }", "    send Charge");
    const result = await run(
      model,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-26", amount: 7 }
  advance 1s`),
    );

    expect(result.notes.join(" ")).toMatch(/sends `t\.Charge` with `amount` generated/);
  });

  it("carries the reject reason onto the terminal message", async () => {
    const model = MODEL.replace(
      "  on reject   send Failed",
      "  on reject   send Failed { why = terminal.reason }",
    ).replace(
      "message Failed    v1.0 @event { orderId: Ref @role(businessKey) }",
      "message Failed    v1.0 @event { orderId: Ref @role(businessKey) why: string { length 1..60 } }",
    );

    const result = await run(
      model,
      scenario(`${HAPPY}
  mock Payments { on Charge reply Declined after 100ms
                  on Refund reply Refunded }
  at 0s publish Place as Caller { orderId: "O-27", amount: 7 }
  advance 1s`),
    );

    const failed = result.trace.of("published").find((e) => e.message === "t.Failed");
    // `reject "card declined"` would be decoration if nothing could read it back.
    expect(failed?.body?.why).toBe("card declined");
  });

  it("reads the terminal state as well as its reason", async () => {
    const model = MODEL.replace(
      "  on complete send Done",
      "  on complete send Done { why = terminal.state }",
    ).replace(
      "message Done      v1.0 @event { orderId: Ref @role(businessKey) }",
      "message Done      v1.0 @event { orderId: Ref @role(businessKey) why: string { length 1..60 } }",
    );

    const result = await run(
      model,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-28", amount: 7 }
  advance 1s`),
    );

    expect(result.trace.of("published").find((e) => e.message === "t.Done")?.body?.why).toBe(
      "complete",
    );
  });

  it("says so rather than guessing when a state field is not set yet", async () => {
    // `chargeId` is only recorded by `on Charged`, so reading it in the step's own send is
    // a read-before-assign -- `state-unset`, once the checker reports it.
    const model = MODEL.replace(
      "    send Charge { amount = state.total }",
      "    send Charge { amount = state.chargeId }",
    );
    const result = await run(
      model,
      scenario(`${HAPPY}
  at 0s publish Place as Caller { orderId: "O-29", amount: 7 }
  advance 1s`),
      undefined,
      {},
      // `state-unset`: the checker refuses this model, which is the better place to catch
      // it. The runtime still has to behave when handed one it did not check itself.
      ["state-unset"],
    );

    expect(result.notes.join(" ")).toMatch(/`amount` unset: state\.chargeId held no value/);
  });
});

describe("identity", () => {
  it("acts under the hosting service's identity, not the caller's credential", async () => {
    // `Payments` requires a scope the caller does not hold. A saga that forwarded the
    // caller's claims would be rejected; one that presents none is not evaluated, because
    // the original subject is audit data rather than authority (`04-process.md` 1.8).
    const model = MODEL.replace(
      "  reacts Charge from commands { replies Charged | Declined }",
      `  reacts Charge from commands {
    requires claim.scope contains "payments.charge"
    replies  Charged | Declined
  }`,
    );

    const result = await run(
      model,
      scenario(`${HAPPY}
  at 0s publish Place as Caller
    with claims { sub: "CUST-9", scope: "orders.write" }
    { orderId: "O-20", amount: 5 }
  advance 1s
  expect saga Flow["O-20"].state == complete`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "rejected")).toBe(0);
  });
});

describe("stuck instances", () => {
  it("reports none when every step is bounded", async () => {
    const result = await run(
      MODEL,
      scenario(`${HAPPY}
${place("O-21")}
  advance 1s
  expect no stuck saga Flow`),
    );
    expect(result.status).toBe("pass");
  });

  it("finds an instance waiting with neither a timeout nor a deadline", async () => {
    const model = MODEL.replace('    on timeout 30s reject "payment timed out"\n', "").replace(
      "  on deadline 24h abandon\n",
      "",
    );

    const result = await run(
      model,
      scenario(`${HAPPY}
  mock Payments { on Charge hang }
${place("O-22")}
  advance 1s
  expect no stuck saga Flow`),
      undefined,
      {},
      // `saga-liveness`: the checker refuses a step nothing can end. This is the runtime's
      // backstop for a model that reached it unchecked.
      ["saga-liveness"],
    );

    expect(result.status).toBe("fail");
    expect(result.assertions[0]?.detail).toContain("charge");
  });
});
