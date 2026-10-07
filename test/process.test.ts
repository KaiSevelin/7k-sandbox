/**
 * Tier 2 again, with the handler in another process.
 *
 * `live.test.ts` runs a handler for real inside this process. This is the same thing across a process
 * boundary, which is what lets the service running for real be written in a language this runtime has
 * never heard of — and lets it sit under its own debugger while everything it talks to stays mocked.
 *
 * **The host here is a Node script, on purpose.** The protocol exists so that a C# or a Go service can
 * take part, and the way to show it is not shaped around any one of them is to implement it in
 * something else entirely. If these pass against twenty lines of JavaScript, writing a C# host is an
 * exercise in C# rather than a question about the design.
 *
 * What is asserted is the handful of things that are easy to get wrong once a pipe is involved: the
 * handshake, correlation, failure mapping, the child's own output, and the child going away.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../src/message.js";
import { overProcess, type ProcessHandler } from "../src/process.js";
import { runScenario } from "../src/runner.js";
import { build } from "./harness.js";

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".scratch", "process");

const MODEL = `
package shop

envelope Meta {
  correlationId: uuid      @role(correlation)
  tenantId:      string { length 1..8 } @role(partitionKey)
}

envelopes Meta

message Charge v1.0 @command {
  orderId: string { length 1..16 } @role(businessKey)
  mode:    string { length 1..16 }
}

message Charged v1.0 @event {
  orderId:  string { length 1..16 } @role(businessKey)
  chargeId: uuid
}

message Declined v1.0 @event {
  orderId: string { length 1..16 } @role(businessKey)
  reason:  string { length 1..32 }
}

pipe commands : queue {
  delivery at-least-once
}

pipe events : topic

service Teller {
  emits Charge to commands
}

service Payments {
  emits Charged  to events
  emits Declined to events

  reacts Charge from commands {
    replies Charged | Declined
    // On the subscription, which is where a retry policy lives: it is the consumer that retries.
    retry   2 after 1s
  }
}
`;

const scenario = (body: string): string =>
  `scenarios for shop\n\nscenario Live {\n  seed 5\n${body}\n}\n`;

/**
 * A host, as a script.
 *
 * `mode` decides what it answers, so one script serves every case — which also shows what a host
 * actually has to do: read `type`, read `body`, and answer with one of the replies the model declares.
 */
const HOST = `
// Standard output is the protocol channel, so everything else a host wants to say goes to stderr.
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
out({ ready: "Payments" });

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\\n");
    if (at < 0) break;
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() === "") continue;
    const d = JSON.parse(line);
    const charged = { id: d.id, handled: true, reply: "Charged", body: {} };

    switch (d.body.mode) {
      case "fail":
        out({ id: d.id, failed: "the gateway timed out" });
        break;
      case "slow":
        // Answered late and so out of order: a host that parallelises is allowed to, which is what
        // the correlation id is for.
        setTimeout(() => out(charged), 80);
        break;
      case "noisy":
        process.stdout.write("a println that should not break anything\\n");
        out(charged);
        break;
      case "decline":
        out({ id: d.id, handled: true, reply: "Declined", body: { reason: "OverLimit" } });
        break;
      case "envelope":
        // Declines with the tenant it was given, so a reply at all proves the envelope crossed
        // flattened and was the right shape.
        out({ id: d.id, handled: true, reply: "Declined", body: { reason: d.envelope.tenantId } });
        break;
      case "die":
        process.exit(3);
        break;
      default:
        out(charged);
    }
  }
});
`;

const WRONG = `process.stdout.write(JSON.stringify({ ready: "Ledger" }) + "\\n");\nsetInterval(() => undefined, 1000);\n`;
const MUTE = `setTimeout(() => process.exit(0), 50);\n`;

beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "host.mjs"), HOST, "utf-8");
  await writeFile(join(dir, "wrong.mjs"), WRONG, "utf-8");
  await writeFile(join(dir, "mute.mjs"), MUTE, "utf-8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const host = (script = "host.mjs"): Promise<ProcessHandler> =>
  overProcess(process.execPath, [join(dir, script)], {
    // Quiet: the child's stderr is the child's business, and one case makes noise deliberately.
    log: () => undefined,
  });

/** Runs one scenario body with the process as `Payments`. */
const run = async (
  handler: ProcessHandler,
  body: string,
): Promise<Awaited<ReturnType<typeof runScenario>>> => {
  const built = build(MODEL, scenario(body));
  return runScenario(built.model, built.file, built.scenarios[0]!, {
    live: new Map([["Payments", handler]]),
  });
};

const published = (result: Awaited<ReturnType<typeof runScenario>>): string[] =>
  result.trace.of("published").map((e) => e.message ?? "");

describe("a host in another process", () => {
  it("introduces itself, and says which service it is", async () => {
    const payments = await host();
    try {
      expect(payments.service).toBe("Payments");
    } finally {
      await payments.close();
    }
  });

  it("handles a delivery for real, and its reply lands on the pipe", async () => {
    const payments = await host();
    try {
      const result = await run(
        payments,
        `  at 0s publish Charge as Teller { orderId: "ORD-1", mode: "plain" }
  advance 1s
  expect Charged on events`,
      );
      expect(result.status).toBe("pass");
      expect(published(result)).toEqual(["shop.Charge", "shop.Charged"]);
    } finally {
      await payments.close();
    }
  });

  it("decides the outcome itself, so the branch under test is the host's own", async () => {
    const payments = await host();
    try {
      const declined = await run(
        payments,
        `  at 0s publish Charge as Teller { orderId: "ORD-2", mode: "decline" }
  advance 1s`,
      );
      expect(published(declined)).toEqual(["shop.Charge", "shop.Declined"]);
    } finally {
      await payments.close();
    }
  });

  it("is handed the envelope, flattened as D50 flattens it", async () => {
    const payments = await host();
    try {
      // The host declines with the tenant it read out of the envelope, so the reply is the evidence.
      const result = await run(
        payments,
        `  at 0s publish Charge as Teller with envelope { tenantId: "acme" } { orderId: "ORD-3", mode: "envelope" }
  advance 1s`,
      );
      expect(published(result)).toContain("shop.Declined");
      expect(result.trace.of("published").at(-1)?.body?.["reason"]).toBe("acme");
    } finally {
      await payments.close();
    }
  });

  it("reads a failure as a handler failure, and retries it under the pipe's policy", async () => {
    const payments = await host();
    try {
      const result = await run(
        payments,
        `  at 0s publish Charge as Teller { orderId: "ORD-4", mode: "fail" }
  advance 1m`,
      );
      // `retry 2 times`: the first delivery and two more.
      expect(result.trace.of("delivered")).toHaveLength(3);
      // And nothing the model does not declare reached a pipe because of it.
      expect(published(result)).toEqual(["shop.Charge"]);
    } finally {
      await payments.close();
    }
  });

  /**
   * At the protocol level, not through the engine.
   *
   * The engine awaits `runLive` before taking the next event, so it never has two deliveries in flight
   * to one handler — which means correlation is not observable through a scenario, and a test that went
   * that way passed against a first-in-first-out implementation. So this calls the handler twice
   * without awaiting the first, which is legal for a `Handler` and is what a host that parallelises
   * would see. The id is defensive rather than load-bearing today; it is one field, and the class of
   * bug it rules out is the kind nobody finds by reading.
   */
  it("correlates by id, so a host may answer out of order", async () => {
    const payments = await host();
    try {
      const message = (orderId: string, mode: string): Message => ({
        envelope: { id: `e-${orderId}`, type: "shop.Charge", version: "v1.0", time: 0, fields: {} },
        body: { orderId, mode },
        from: "shop.Teller",
        claims: {},
      });

      // The first is answered 80ms late, so the answers arrive in the opposite order to the asks.
      const slow = payments(message("ORD-5", "slow"));
      const quick = payments(message("ORD-6", "decline"));

      expect((await slow).reply).toBe("Charged");
      expect((await quick).reply).toBe("Declined");
    } finally {
      await payments.close();
    }
  });

  it("survives a host that writes to its own standard output", async () => {
    const payments = await host();
    try {
      // A `println` in a handler is the most ordinary thing in the world, and stdout is the protocol
      // channel. It is reported as the child's output rather than treated as a protocol fault.
      const result = await run(
        payments,
        `  at 0s publish Charge as Teller { orderId: "ORD-7", mode: "noisy" }
  advance 1s
  expect Charged on events`,
      );
      expect(result.status).toBe("pass");
    } finally {
      await payments.close();
    }
  });

  it("reads a host that dies mid-delivery as a failure, which is all the model can tell", async () => {
    const payments = await host();
    try {
      // D26: a process that died and a handler that threw are the same observable downstream.
      const result = await run(
        payments,
        `  at 0s publish Charge as Teller { orderId: "ORD-8", mode: "die" }
  advance 1m`,
      );
      expect(published(result)).toEqual(["shop.Charge"]);
      expect(result.trace.of("delivered").length).toBeGreaterThanOrEqual(1);
    } finally {
      await payments.close();
    }
  });
});

describe("a host that cannot be used", () => {
  it("is refused when it is the wrong service", async () => {
    await expect(
      overProcess(process.execPath, [join(dir, "wrong.mjs")], {
        expect: "Payments",
        log: () => undefined,
      }),
    ).rejects.toThrow(/is `Ledger`/);
  });

  it("is reported when it never introduces itself, rather than hanging", async () => {
    await expect(
      overProcess(process.execPath, [join(dir, "mute.mjs")], {
        startupMs: 3_000,
        log: () => undefined,
      }),
    ).rejects.toThrow(/before saying what service it is/);
  });

  it("is reported when the command cannot be run at all", async () => {
    await expect(
      overProcess(join(dir, "no-such-thing-at-all"), [], { startupMs: 3_000, log: () => undefined }),
    ).rejects.toThrow(/could not be run/);
  });

  it("closes without minding being asked twice", async () => {
    const payments = await host();
    await payments.close();
    await payments.close();
  });
});
