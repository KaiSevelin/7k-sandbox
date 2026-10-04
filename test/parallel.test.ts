/**
 * Parallel saga steps, run.
 *
 * Core can check that two branches do not race; only a run can show that they are actually
 * concurrent — sent at the same instant, joined in whichever order the replies arrive, and unwound in
 * reverse **completion** order rather than reverse declaration order. The two orders differ whenever
 * the second-declared branch finishes first, so every compensation test here arranges exactly that.
 */

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";
import type { ScenarioResult } from "../src/runner.js";

const MODEL = `
package t

envelope Meta {
  correlationId: uuid @role(correlation)
  customerId:    string { length 1..8 } @role(partitionKey)
}

envelopes Meta

value Ref : string { length 1..16 }

message Place    v1.0 @command { orderId: Ref @role(businessKey) }
message Accepted v1.0 @event   { orderId: Ref @role(businessKey) }

message Hold     v1.0 @command { orderId: Ref @role(businessKey) }
message Held     v1.0 @event   { orderId: Ref @role(businessKey) holdRef: uuid }
message Short    v1.0 @event   { orderId: Ref @role(businessKey) }
message Release  v1.0 @command { orderId: Ref @role(businessKey) }

message Auth     v1.0 @command { orderId: Ref @role(businessKey) }
message Authed   v1.0 @event   { orderId: Ref @role(businessKey) authRef: uuid }
message Declined v1.0 @event   { orderId: Ref @role(businessKey) }
message Void     v1.0 @command { orderId: Ref @role(businessKey) }

message Ship        v1.0 @command { orderId: Ref @role(businessKey) holdRef: uuid authRef: uuid }
message Shipped     v1.0 @event   { orderId: Ref @role(businessKey) }
message Unshippable v1.0 @event   { orderId: Ref @role(businessKey) }
message Unship      v1.0 @command { orderId: Ref @role(businessKey) }

message Done   v1.0 @event { orderId: Ref @role(businessKey) }
message Failed v1.0 @event { orderId: Ref @role(businessKey) }
message GaveUp v1.0 @event { orderId: Ref @role(businessKey) }

pipe commands : queue
pipe events   : topic

service Caller {
  emits Place to commands
}

service Orders {
  emits Accepted to events
  emits Hold     to commands
  emits Release  to commands
  emits Auth     to commands
  emits Void     to commands
  emits Ship     to commands
  emits Unship   to commands
  emits Done     to events
  emits Failed   to events
  emits GaveUp   to events

  reacts Place       from commands { replies Accepted }
  reacts Held        from events   { replies none }
  reacts Short       from events   { replies none }
  reacts Authed      from events   { replies none }
  reacts Declined    from events   { replies none }
  reacts Shipped     from events   { replies none }
  reacts Unshippable from events   { replies none }
}

service Warehouse {
  emits Held  to events
  emits Short to events

  reacts Hold    from commands { replies Held | Short }
  reacts Release from commands { replies none }
}

service Cards {
  emits Authed   to events
  emits Declined to events

  reacts Auth from commands { replies Authed | Declined }
  reacts Void from commands { replies none }
}

service Shipping {
  emits Shipped     to events
  emits Unshippable to events

  reacts Ship   from commands { replies Shipped | Unshippable }
  reacts Unship from commands { replies none }
}

service Observer {
  reacts Accepted from events { replies none }
  reacts Done     from events { replies none }
  reacts Failed   from events { replies none }
  reacts GaveUp   from events { replies none }
}

saga Flow v1.0 {
  start on Place keyed by orderId

  state {
    holdRef: uuid
    authRef: uuid
  }

  parallel {
    step hold {
      send Hold
      on Held { holdRef = message.holdRef }
      on Short reject "out of stock"
      on timeout 30s reject "the warehouse did not answer"
      undo with Release
    }

    step authorise {
      send Auth
      on Authed { authRef = message.authRef }
      on Declined reject "card declined"
      on timeout 30s reject "the card network did not answer"
      undo with Void
    }
  }

  step ship {
    send Ship
    on Shipped
    on Unshippable reject "cannot ship"
    on timeout 2m  reject "shipping timed out"
  }

  on deadline 24h abandon

  on complete send Done
  on reject   send Failed
  on abandon  send GaveUp
}
`;

const scenario = (body: string): string => `scenarios for t\n\nscenario S {\n  seed 1\n${body}\n}\n`;

const place = `  at 0s publish Place as Caller { orderId: "O-1" }`;

/**
 * Mocks with explicit, unequal delays.
 *
 * `auth` is deliberately the faster of the two, so the branch declared **second** completes
 * **first**. Every ordering assertion below depends on that, because it is the only arrangement in
 * which completion order and declaration order disagree.
 */
const both = (holdReply: string, authReply: string): string => `  mock Warehouse {
    on Hold    reply ${holdReply}
    on Release reply none
  }
  mock Cards {
    on Auth reply ${authReply}
    on Void reply none
  }
  mock Shipping {
    on Ship   reply Shipped after 10ms
    on Unship reply none
  }`;

/** Every event of a kind, in order, as `message` or `detail` — whichever the kind carries. */
const detailsOf = (result: ScenarioResult, kind: string): string[] =>
  result.trace
    .all()
    .filter((e) => e.kind === kind)
    .map((e) => e.detail ?? e.message ?? "");

/**
 * The first publication of a message type: its virtual time and its body.
 *
 * It asserts the event exists, because a helper that returns `undefined` for a message nobody sent
 * makes `toBe(undefined)` pass for two messages that were never sent at all.
 */
const published = (result: ScenarioResult, type: string) => {
  const event = result.trace.all().find((e) => e.kind === "published" && e.message === `t.${type}`);
  expect(event, `no ${type} was published`).toBeDefined();
  return event!;
};

describe("a stage", () => {
  it("sends every branch at the same instant", async () => {
    // The point of the construct. Sequential steps would put `Auth` 200ms after `Hold`, because the
    // second step is not entered until the first one's reply arrives.
    const result = await run(
      MODEL,
      scenario(`${both("Held after 200ms", "Authed after 50ms")}
${place}
  advance 1s
  expect saga Flow["O-1"].state == complete`),
    );

    expect(result.status).toBe("pass");
    expect(published(result, "Hold").at).toBe(published(result, "Auth").at);
  });

  it("holds the saga until its last branch joins", async () => {
    const result = await run(
      MODEL,
      scenario(`${both("Held after 200ms", "Authed after 50ms")}
${place}
  advance 100ms
  expect saga Flow["O-1"].state == hold
  advance 1s
  expect saga Flow["O-1"].state == complete`),
    );

    expect(result.status).toBe("pass");
  });

  it("is no longer in a branch that has already joined", async () => {
    // `authorise` replied at 50ms, so at 100ms the instance is in `hold` and not in `authorise`.
    const result = await run(
      MODEL,
      scenario(`${both("Held after 200ms", "Authed after 50ms")}
${place}
  advance 100ms
  expect saga Flow["O-1"].state == authorise`),
    );

    expect(result.status).toBe("fail");
  });

  it("advances once per branch, then once for the step after it", async () => {
    const result = await run(
      MODEL,
      scenario(`${both("Held after 200ms", "Authed after 50ms")}
${place}
  advance 1s`),
    );

    // `authorise` first, because it was the faster: the trace records what happened, not what was
    // written.
    expect(detailsOf(result, "saga-advanced")).toEqual(["authorise", "hold", "ship"]);
  });

  it("carries state out of every branch and into the next stage", async () => {
    // The join's real job. `Ship` takes both refs by name match, so if either branch's assignment
    // were lost — overwritten, or dropped when the stage advanced — the value reaching `Shipping`
    // would be a generated uuid rather than the one the reply carried.
    const result = await run(
      MODEL,
      scenario(`${both("Held after 200ms", "Authed after 50ms")}
${place}
  advance 1s
  expect saga Flow["O-1"].state == complete`),
    );

    expect(result.status).toBe("pass");
    const ship = published(result, "Ship").body;
    expect(ship?.holdRef).toBe(published(result, "Held").body?.holdRef);
    expect(ship?.authRef).toBe(published(result, "Authed").body?.authRef);
  });
});

describe("unwinding a stage", () => {
  it("compensates the branch that completed and not the one that failed", async () => {
    // `hold` succeeds at 50ms; `authorise` is declined at 100ms. `Release` reverses the first.
    // `Void` must not be sent: a step that never completed has nothing to reverse.
    const result = await run(
      MODEL,
      scenario(`${both("Held after 50ms", "Declined after 100ms")}
${place}
  advance 1s
  expect saga Flow["O-1"].state == reject
  expect Release on commands
  expect no Void on commands
  expect Failed on events`),
    );

    expect(result.status).toBe("pass");
    expect(detailsOf(result, "saga-compensating")).toEqual(["hold"]);
  });

  it("compensates the other way round just as readily", async () => {
    const result = await run(
      MODEL,
      scenario(`${both("Short after 100ms", "Authed after 50ms")}
${place}
  advance 1s
  expect saga Flow["O-1"].state == reject
  expect Void on commands
  expect no Release on commands`),
    );

    expect(result.status).toBe("pass");
    expect(detailsOf(result, "saga-compensating")).toEqual(["authorise"]);
  });

  it("stops the sibling's clock, so a rejected stage does not also time out", async () => {
    // `authorise` is declined at 100ms while `hold` hangs. Its 30s timeout was armed when the stage
    // was entered and must be cancelled by the rejection, not fire into a terminated instance.
    const result = await run(
      MODEL,
      scenario(`  mock Warehouse {
    on Hold    hang
    on Release reply none
  }
  mock Cards {
    on Auth reply Declined after 100ms
    on Void reply none
  }
${place}
  advance 2m
  expect saga Flow["O-1"].state == reject`),
    );

    expect(result.status).toBe("pass");
    expect(detailsOf(result, "saga-timeout")).toEqual([]);
    // `hold` never completed, so nothing is reversed at all.
    expect(detailsOf(result, "saga-compensating")).toEqual([]);
  });

  it("unwinds a later failure in reverse completion order", async () => {
    // Both branches complete — `authorise` at 50ms, `hold` at 200ms — and then `ship` fails. Reverse
    // completion order is `hold`, `authorise`. Reverse *declaration* order would be the other way
    // round, which is why this assertion is the one that distinguishes the two rules.
    const result = await run(
      MODEL,
      scenario(`  mock Warehouse {
    on Hold    reply Held after 200ms
    on Release reply none
  }
  mock Cards {
    on Auth reply Authed after 50ms
    on Void reply none
  }
  mock Shipping {
    on Ship   reply Unshippable after 10ms
    on Unship reply none
  }
${place}
  advance 1s
  expect saga Flow["O-1"].state == reject`),
    );

    expect(result.status).toBe("pass");
    expect(detailsOf(result, "saga-compensating")).toEqual(["hold", "authorise"]);
  });

  it("abandons a whole stage on the saga's deadline", async () => {
    // Neither branch answers. The deadline bounds the stage as a whole, which is the same rule a
    // sequential step gets — `stuck` must not be reported for a stage nobody could have joined.
    const result = await run(
      MODEL,
      scenario(`  mock Warehouse {
    on Hold    hang
    on Release reply none
  }
  mock Cards {
    on Auth hang
    on Void reply none
  }
${place}
  advance 2m
  expect saga Flow["O-1"].state == reject
  expect no stuck saga Flow`),
    );

    expect(result.status).toBe("pass");
    // Both branches time out at 30s. The first to fire rejects the saga; the second must find the
    // instance already terminated and do nothing.
    expect(detailsOf(result, "saga-timeout").length).toBe(1);
  });
});
