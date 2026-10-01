/**
 * What the engine does, stated as behaviour rather than as structure.
 *
 * Each test is about one claim a 7K declaration makes: a guarantee, a filter, a
 * deduplication key, a retry policy. If the engine did not honour them a scenario
 * would be asserting against a toy, and the declarations would be documentation.
 */

import { describe, expect, it } from "vitest";
import { countOf, kinds, run } from "./harness.js";

const MODEL = `
package t

envelope Meta {
  tenantId: string { length 1..8 }
  channel:  string { length 1..8 }
}

envelopes Meta

message Work v1.0 @command {
  jobId: string { length 1..16 } @role(businessKey)
}

message Done v1.0 @event {
  jobId: string { length 1..16 } @role(businessKey)
}

message Noise v1.0 @event {
  jobId: string { length 1..16 } @role(businessKey)
}

pipe commands : queue
pipe events   : topic
pipe lossy    : topic {
  delivery at-most-once
  dlq      none
}

service Worker {
  emits Done to events

  reacts Work from commands {
    replies Done
  }
}

service Watcher {
  reacts Done from events { replies none }
}
`;

const scenario = (body: string): string => `scenarios for t\n\nscenario S {\n  seed 1\n${body}\n}\n`;

const PUBLISH = `  at 0s publish Work as Nobody { jobId: "J-1" }`;

/** A sender the model does not declare would not resolve, so Worker emits Work too. */
const MODEL_WITH_SENDER = MODEL.replace(
  "service Worker {\n  emits Done to events",
  "service Starter {\n  emits Work to commands\n}\n\nservice Worker {\n  emits Done to events",
);

const send = `  at 0s publish Work as Starter { jobId: "J-1" }`;

describe("delivery", () => {
  it("delivers, runs the handler and puts the reply on the declared pipe", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work reply Done after 100ms }
${send}
  advance 1s
  expect Done on events`),
    );

    expect(result.status).toBe("pass");
    expect(kinds(result)).toEqual([
      "published",
      "delivered",
      "handled",
      "published",
      "delivered",
      "handled",
    ]);
  });

  it("fans a topic out to every subscription but gives a queue message to one consumer", async () => {
    const model = MODEL_WITH_SENDER.replace(
      "service Watcher {\n  reacts Done from events { replies none }\n}",
      `service Watcher {
  reacts Done from events { replies none }
}

service Auditor {
  reacts Done from events { replies none }
}`,
    );

    const result = await run(
      model,
      scenario(`  mock Worker { on Work reply Done }
${send}
  advance 1s`),
    );

    // One Work delivery on the queue; two Done deliveries on the topic.
    expect(countOf(result, "delivered")).toBe(3);
  });

  it("does not deliver what a `where` filter declines, and never retries it", async () => {
    const model = MODEL_WITH_SENDER.replace(
      "reacts Done from events { replies none }",
      `reacts Done from events {
    where   envelope.channel == "kiosk"
    replies none
  }`,
    );

    const result = await run(
      model,
      scenario(`  mock Worker { on Work reply Done }
  at 0s publish Work as Starter with envelope { channel: "web" } { jobId: "J-1" }
  advance 1s
  expect no Done on events.dead`),
    );

    expect(result.status).toBe("pass");
    expect(kinds(result)).toContain("filtered");
    expect(countOf(result, "retrying")).toBe(0);
  });
});

describe("deduplication", () => {
  it("drops a second message with the same business key", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work reply Done }
${send}
${send}
  advance 1s
  expect Worker handled Work count 1`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "deduplicated")).toBe(1);
  });

  it("honours `once per none` as a claim of natural idempotence", async () => {
    const model = MODEL_WITH_SENDER.replace(
      "reacts Work from commands {\n    replies Done",
      "reacts Work from commands {\n    once per none\n    replies Done",
    );

    const result = await run(
      model,
      scenario(`  mock Worker { on Work reply Done }
${send}
${send}
  advance 1s
  expect Worker handled Work count 2`),
    );

    expect(result.status).toBe("pass");
    // Watcher still deduplicates the two replies; the claim is about Worker.
    expect(
      result.trace.of("deduplicated").filter((e) => e.service === "Worker"),
    ).toEqual([]);
  });

  it("releases the key on a failed attempt, so a redelivery reaches the handler", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work sequence { fail; reply Done } }
${send}
  advance 1s
  expect Worker handled Work count 1
  expect Done on events`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "deduplicated")).toBe(0);
  });
});

describe("failure and the delivery guarantee", () => {
  it("retries with exponential backoff, then dead-letters", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work fail }
${send}
  advance 1m
  expect Work on commands.dead`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "retrying")).toBe(3); // the default is three retries
    expect(countOf(result, "dead-lettered")).toBe(1);

    const delays = result.trace
      .of("delivered")
      .map((e) => e.at - result.trace.all()[0]!.at);
    expect(delays).toEqual([0, 1000, 3000, 7000]);
  });

  it("obeys a declared retry policy, including its ceiling", async () => {
    const model = MODEL_WITH_SENDER.replace(
      "reacts Work from commands {\n    replies Done",
      "reacts Work from commands {\n    retry 4 after 10s max 15s\n    replies Done",
    );

    const result = await run(
      model,
      scenario(`  mock Worker { on Work fail }
${send}
  advance 5m`),
    );

    const start = result.trace.all()[0]!.at;
    expect(result.trace.of("delivered").map((e) => e.at - start)).toEqual([
      // 10s, then the ceiling: 20s would exceed `max 15s`, so every later wait is 15s.
      0, 10_000, 25_000, 40_000, 55_000,
    ]);
  });

  it("redelivers a handler that never answers, because silence is not an acknowledgement", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work hang }
${send}
  advance 2m
  expect Work on commands.dead`),
      undefined,
      { ackTimeoutMs: 5_000 },
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("failed").every((e) => e.reason === "timeout")).toBe(true);
  });

  it("distinguishes `hang` from `reply none`: one owed an answer and withheld it", async () => {
    // Watcher declares `replies none`, so answering with nothing is its happy path.
    const silent = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker  { on Work reply Done }
  mock Watcher { on Done reply none }
${send}
  advance 1m`),
    );

    expect(silent.status).toBe("pass");
    expect(countOf(silent, "failed")).toBe(0);
    expect(countOf(silent, "dead-lettered")).toBe(0);

    const hung = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker  { on Work reply Done }
  mock Watcher { on Done hang }
${send}
  advance 1m`),
    );

    // Watcher owed nothing, yet `hang` is still a withheld acknowledgement, so the
    // broker redelivers and eventually gives up.
    expect(countOf(hung, "dead-lettered")).toBe(1);
  });

  it("loses a failure on an at-most-once pipe, because there is nowhere for it to go", async () => {
    const model = MODEL_WITH_SENDER.replace(
      "reacts Done from events { replies none }",
      "reacts Noise from lossy { replies none }",
    )
      .replace("service Worker {\n  emits Done to events", "service Worker {\n  emits Noise to lossy")
      .replace("reacts Work from commands {\n    replies Done", "reacts Work from commands {\n    replies Noise");

    const result = await run(
      model,
      scenario(`  mock Worker { on Work fail }
${send}
  advance 1m`),
    );

    // `commands` is at-least-once, so Work still dead-letters; the point is `lossy`
    // carries no dead-letter pipe of its own.
    expect(result.trace.of("dead-lettered").map((e) => e.pipe)).toEqual(["t.commands.dead"]);
  });
});

describe("authorization", () => {
  const model = MODEL_WITH_SENDER.replace(
    "reacts Work from commands {\n    replies Done",
    'reacts Work from commands {\n    requires claim.tid == envelope.tenantId\n    replies Done',
  );

  it("rejects a failing claim check without retrying it", async () => {
    const result = await run(
      model,
      scenario(`  mock Worker { on Work reply Done }
  at 0s publish Work as Starter
    with claims   { tid: "acme" }
    with envelope { tenantId: "other" }
    { jobId: "J-1" }
  advance 1m
  expect rejected Work at Worker reason unauthorized`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "retrying")).toBe(0);
  });

  it("accepts a claim set that satisfies the predicate", async () => {
    const result = await run(
      model,
      scenario(`  mock Worker { on Work reply Done }
  at 0s publish Work as Starter
    with claims   { tid: "acme" }
    with envelope { tenantId: "acme" }
    { jobId: "J-1" }
  advance 1m
  expect Done on events`),
    );

    expect(result.status).toBe("pass");
  });

  it("does not evaluate `requires` when the sender modelled no identity at all", async () => {
    const result = await run(
      model,
      scenario(`  mock Worker { on Work reply Done }
${send}
  advance 1m
  expect Done on events`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "rejected")).toBe(0);
  });
});

describe("mock selection", () => {
  it("advances a sequence per call and repeats its last outcome", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work sequence { fail; fail; reply Done } }
${send}
  advance 1m
  expect Done on events
  expect no message on commands.dead`),
    );

    expect(result.status).toBe("pass");
    expect(countOf(result, "retrying")).toBe(2);
  });

  it("chooses a conditional branch from the message, and falls back to `otherwise`", async () => {
    const body = (channel: string): string => `  mock Worker {
    on Work {
      when envelope.channel == "kiosk" fail
      otherwise                        reply Done
    }
  }
  at 0s publish Work as Starter with envelope { channel: "${channel}" } { jobId: "J-1" }
  advance 1m`;

    expect(countOf(await run(MODEL_WITH_SENDER, scenario(body("kiosk"))), "failed")).toBeGreaterThan(0);
    expect(countOf(await run(MODEL_WITH_SENDER, scenario(body("web"))), "failed")).toBe(0);
  });

  it("draws a weighted outcome from the seed, so the same seed gives the same run", async () => {
    const once = async (seed: number): Promise<string[]> =>
      kinds(
        await run(
          MODEL_WITH_SENDER,
          `scenarios for t\n\nscenario S {\n  seed ${seed}\n  mock Worker { on Work { 50% reply Done\n 50% fail } }\n${send}\n  advance 1m\n}\n`,
        ),
      );

    expect(await once(3)).toEqual(await once(3));
  });

  it("succeeds silently for an unscripted subscription that owes no reply", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work reply Done }
${send}
  advance 1m
  expect Watcher handled Done count 1`),
    );

    // Watcher is never mocked, and `replies none` means it owes nothing.
    expect(result.status).toBe("pass");
  });

  it("hangs an unscripted subscription that does owe a reply, and says so", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`${send}
  advance 1m`),
    );

    expect(result.notes.join(" ")).toMatch(/owes a reply .* neither live nor mocked/);
    expect(countOf(result, "dead-lettered")).toBe(1);
  });
});

describe("the composer", () => {
  it("refuses an invalid payload and says `unchecked` is how to send it anyway", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  at 0s publish Work as Starter { jobId: { $invalid: "length" } }
  advance 1s`),
    );

    expect(result.status).toBe("fail");
    expect(result.errors.join(" ")).toMatch(/unchecked/);
    expect(countOf(result, "published")).toBe(0);
  });

  it("sends an invalid payload when told to, and the consumer rejects it", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  at 0s publish Work as Starter unchecked { jobId: { $invalid: "length" } }
  advance 1s
  expect Work on commands.dead`),
    );

    expect(result.status).toBe("pass");
    expect(result.trace.of("rejected")[0]?.reason).toBe("invalid");
    expect(countOf(result, "retrying")).toBe(0);
  });
});

describe("the envelope", () => {
  it("propagates correlation and derives causation from the inbound message", async () => {
    const result = await run(
      MODEL_WITH_SENDER.replace(
        "envelope Meta {",
        "envelope Meta {\n  correlationId: uuid @role(correlation)\n  causationId:   uuid @derive(inbound.id) @role(causation)",
      ),
      scenario(`  mock Worker { on Work reply Done }
${send}
  advance 1s`),
    );

    const published = result.trace.of("published");
    const request = published[0]!;
    const reply = published[1]!;

    expect(reply.envelope?.correlationId).toBe(request.envelope?.correlationId);
    expect(reply.envelope?.causationId).toBe(request.id);
  });

  it("carries an unspecified reply field over from the request", async () => {
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work reply Done }
${send}
  advance 1s`),
    );

    const [request, reply] = result.trace.of("published");
    expect(reply?.body?.jobId).toBe(request?.body?.jobId);
  });
});

describe("the clock", () => {
  it("runs a thirty-day advance without waiting for it", async () => {
    const started = Date.now();
    const result = await run(
      MODEL_WITH_SENDER,
      scenario(`  mock Worker { on Work reply Done after 29d }
${send}
  advance 30d
  expect Done on events`),
    );

    expect(result.status).toBe("pass");
    expect(result.elapsedMs).toBe(30 * 86_400_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is reproducible: the same scenario and seed give the same trace", async () => {
    const once = async (): Promise<string> =>
      (
        await run(
          MODEL_WITH_SENDER,
          scenario(`  mock Worker { on Work reply Done after 100ms }
${send}
  advance 1s`),
        )
      ).trace.toNdjson();

    expect(await once()).toBe(await once());
  });
});

void PUBLISH;
