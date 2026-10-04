/**
 * A query is answered every time it is asked.
 *
 * The bug this exists to prevent is quiet and expensive. A deduplication key defaults to the message's
 * `@role(businessKey)` field, and a query naturally has one — it is the thing being asked about. So
 * before `@query` existed, a read modelled as a command was silently collapsed: the second caller asking
 * the same question got no answer at all, and nothing in the trace said why it was dropped except
 * `deduplicated`, which looked like the system working correctly.
 *
 * Answering a question twice is correct, so a query carries no key (7k D100).
 */

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const MODEL = `package acme

message GetParcel v1.0 @query {
  parcelRef: string @role(businessKey) { length 1..32 }
}

message ParcelStatus v1.0 @event {
  parcelRef: string @role(businessKey) { length 1..32 }
}

message MoveParcel v1.0 @command {
  parcelRef: string @role(businessKey) { length 1..32 }
}

message ParcelMoved v1.0 @event {
  parcelRef: string @role(businessKey) { length 1..32 }
}

pipe reads  : queue { retention 1d }
pipe writes : queue { retention 1d }
pipe events : topic { retention 1d }

service Asker {
  emits GetParcel  to reads
  emits MoveParcel to writes
  reacts ParcelStatus from events { once per none; replies none }
  reacts ParcelMoved  from events { replies none }
}

service Teller {
  emits ParcelStatus to events
  emits ParcelMoved  to events

  reacts GetParcel from reads {
    replies ParcelStatus
  }

  reacts MoveParcel from writes {
    replies ParcelMoved
  }
}
`;

const SCENARIOS = `scenarios for acme

mockset Answering {
  mock Teller {
    on GetParcel  reply ParcelStatus after 10ms
    on MoveParcel reply ParcelMoved  after 10ms
  }
}

// The same question, twice.
scenario AskedTwice {
  seed 1
  use  Answering

  at 0s publish GetParcel as Asker { parcelRef: "PCL-1" }
  at 1s publish GetParcel as Asker { parcelRef: "PCL-1" }
  advance 2s
}

// The same instruction, twice. Which is the case deduplication is for.
scenario ToldTwice {
  seed 1
  use  Answering

  at 0s publish MoveParcel as Asker { parcelRef: "PCL-1" }
  at 1s publish MoveParcel as Asker { parcelRef: "PCL-1" }
  advance 2s
}
`;

const trace = async (name: string) => (await run(MODEL, SCENARIOS, name)).trace.all();

describe("a query", () => {
  it("is handled both times it is asked", async () => {
    const events = await trace("AskedTwice");
    const handled = events.filter((e) => e.kind === "handled" && e.message === "acme.GetParcel");
    expect(handled).toHaveLength(2);
  });

  it("is never deduplicated, however identical the two asks", async () => {
    const events = await trace("AskedTwice");
    expect(events.filter((e) => e.kind === "deduplicated")).toEqual([]);
  });

  it("is answered twice, which is the point", async () => {
    const events = await trace("AskedTwice");
    const answers = events.filter(
      (e) => e.kind === "published" && e.message === "acme.ParcelStatus",
    );
    expect(answers).toHaveLength(2);
  });
});

describe("a command, for contrast", () => {
  it("is deduplicated on the same business key", async () => {
    // The same shape of model and the same pair of messages: the only difference is the intent, and it
    // is the difference between absorbing a repeat and answering it.
    const events = await trace("ToldTwice");
    expect(events.filter((e) => e.kind === "deduplicated")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "handled" && e.message === "acme.MoveParcel")).toHaveLength(1);
  });
});
