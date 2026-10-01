/**
 * Tier 2: a live handler, with everything it talks to mocked.
 *
 * This is the point of the whole exercise. A handler is written once and runs
 * unchanged at three fidelities — fully mocked in CI, live here in development, and
 * against a real deployment in the conformance pass — because liveness is chosen by
 * the runner and is not part of what the scenario claims
 * (`docs/spec/30-scenarios.md` section 4).
 *
 * What the handler sees is what a generated wrapper would hand it: validated,
 * normalized, deduplicated. It cannot tell which transport delivered the message, and
 * that is the property worth protecting — a test that ran the handler through a
 * different code path would not be testing the handler you deploy.
 */

import { describe, expect, it } from "vitest";
import type { Handler, HandlerResult } from "../src/engine.js";
import type { Message } from "../src/message.js";
import { runScenario } from "../src/runner.js";
import { build, countOf } from "./harness.js";

const MODEL = `
package shop

envelope Meta {
  correlationId: uuid      @role(correlation)
  tenantId:      string { length 1..8 } @role(partitionKey)
}

envelopes Meta

value Money : decimal(18,2) { range 0.. }

message Charge v1.0 @command {
  orderId: string { length 1..16 } @role(businessKey)
  amount:  Money
}

message Charged v1.0 @event {
  orderId:  string { length 1..16 } @role(businessKey)
  chargeId: uuid
}

message Declined v1.0 @event {
  orderId: string { length 1..16 } @role(businessKey)
  reason:  string { length 1..32 }
}

message Receipt v1.0 @command {
  orderId: string { length 1..16 } @role(businessKey)
}

pipe commands : queue
pipe events   : topic

service Teller {
  emits Charge to commands
}

service Payments {
  emits Charged  to events
  emits Declined to events

  reacts Charge from commands {
    replies Charged | Declined
  }
}

service Ledger {
  emits Receipt to commands

  reacts Charged from events {
    replies Receipt
  }
}
`;

const scenario = (body: string): string => `scenarios for shop\n\nscenario Live {\n  seed 5\n${body}\n}\n`;

/**
 * The handler under test. Plain, and knowing nothing about this sandbox: it reads the
 * message it was given and names one of its declared replies.
 */
interface Seen {
  readonly calls: Message[];
}

function payments(seen: Seen, limit: number): Handler {
  return (message): HandlerResult => {
    seen.calls.push(message);
    const amount = Number(message.body.amount);
    return amount > limit
      ? { reply: "Declined", body: { reason: "OverLimit" } }
      : { reply: "Charged", body: {} };
  };
}

describe("a live handler", () => {
  it("runs for real while its collaborators stay mocked", async () => {
    const seen: Seen = { calls: [] };
    const built = build(
      MODEL,
      scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller { orderId: "ORD-1", amount: "49.50" }
  advance 1s
  expect Charged on events
  expect Ledger  handled Charged count 1`),
    );

    const result = await runScenario(built.model, built.file, built.scenarios[0]!, {
      live: new Map([["Payments", payments(seen, 100)]]),
    });

    expect(result.status).toBe("pass");
    expect(seen.calls).toHaveLength(1);
  });

  it("decides the outcome itself, so the branch under test is the handler's own", async () => {
    const run = async (amount: string): Promise<string[]> => {
      const built = build(
        MODEL,
        scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller { orderId: "ORD-2", amount: "${amount}" }
  advance 1s`),
      );
      const result = await runScenario(built.model, built.file, built.scenarios[0]!, {
        live: new Map([["Payments", payments({ calls: [] }, 100)]]),
      });
      return result.trace.of("published").map((e) => e.message ?? "");
    };

    expect(await run("49.50")).toEqual(["shop.Charge", "shop.Charged", "shop.Receipt"]);
    expect(await run("250.00")).toEqual(["shop.Charge", "shop.Declined"]);
  });

  it("hands the handler a validated, normalized, envelope-bearing message", async () => {
    const seen: Seen = { calls: [] };
    const built = build(
      MODEL,
      scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller
    with envelope { tenantId: "acme" }
    { orderId: "ORD-3", amount: "10.00" }
  advance 1s`),
    );

    await runScenario(built.model, built.file, built.scenarios[0]!, {
      live: new Map([["Payments", payments(seen, 100)]]),
    });

    const message = seen.calls[0]!;
    expect(message.envelope.type).toBe("shop.Charge");
    expect(message.envelope.version).toBe("1.0");
    expect(message.envelope.fields.tenantId).toBe("acme");
    // A correlation id the scenario never wrote, because a runtime supplies it.
    expect(message.envelope.fields.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(message.body).toEqual({ orderId: "ORD-3", amount: "10.00" });
  });

  it("never sees a duplicate the deduplication key already absorbed", async () => {
    const seen: Seen = { calls: [] };
    const built = build(
      MODEL,
      scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller { orderId: "ORD-4", amount: "1.00" }
  at 0s publish Charge as Teller { orderId: "ORD-4", amount: "1.00" }
  advance 1s`),
    );

    const result = await runScenario(built.model, built.file, built.scenarios[0]!, {
      live: new Map([["Payments", payments(seen, 100)]]),
    });

    expect(seen.calls).toHaveLength(1);
    expect(countOf(result, "deduplicated")).toBe(1);
  });

  it("treats a thrown error as a handler failure, and retries it under the policy", async () => {
    let attempts = 0;
    const flaky: Handler = () => {
      attempts++;
      if (attempts < 3) throw new Error("the database deadlocked");
      return { reply: "Charged", body: {} };
    };

    const built = build(
      MODEL,
      scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller { orderId: "ORD-5", amount: "1.00" }
  advance 1m
  expect Charged on events
  expect no message on commands.dead`),
    );

    const result = await runScenario(built.model, built.file, built.scenarios[0]!, {
      live: new Map([["Payments", flaky]]),
    });

    expect(result.status).toBe("pass");
    expect(attempts).toBe(3);
    // The cause is outside the model, so the trace records only that it failed.
    expect(result.trace.of("failed").map((e) => e.detail)).toEqual([
      "the database deadlocked",
      "the database deadlocked",
    ]);
  });

  it("awaits an asynchronous handler before the reply is on the pipe", async () => {
    const slow: Handler = async (message) => {
      await Promise.resolve();
      return { reply: "Charged", body: { chargeId: "00000000-0000-7000-8000-000000000001" } };
    };

    const built = build(
      MODEL,
      scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller { orderId: "ORD-6", amount: "1.00" }
  advance 1s
  expect Charged on events { chargeId: "00000000-0000-7000-8000-000000000001" }`),
    );

    const result = await runScenario(built.model, built.file, built.scenarios[0]!, {
      live: new Map([["Payments", slow]]),
    });

    expect(result.status).toBe("pass");
  });

  it("fills a reply field the handler left out from the request, as a mock's would be", async () => {
    const terse: Handler = () => ({ reply: "Charged" });

    const built = build(
      MODEL,
      scenario(`  mock Ledger { on Charged reply Receipt }
  at 0s publish Charge as Teller { orderId: "ORD-7", amount: "1.00" }
  advance 1s`),
    );

    const result = await runScenario(built.model, built.file, built.scenarios[0]!, {
      live: new Map([["Payments", terse]]),
    });

    const charged = result.trace.of("published").find((e) => e.message === "shop.Charged");
    expect(charged?.body?.orderId).toBe("ORD-7");
    expect(charged?.body?.chargeId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
