/**
 * The trace: NDJSON, one envelope event per line.
 *
 * One of 7K's published interchange artifacts (`docs/spec/30-scenarios.md` section
 * 7), which is why its shape is not this runtime's private business. Specifying it
 * is what lets a tool read any runtime's output: Spider never talks to the sandbox
 * directly, a trace file is a shareable bug report, and a converter from
 * OpenTelemetry spans can point the same views at production.
 */

import type { JsonValue } from "@sevenk/core";
import type { VirtualTime } from "./clock.js";
import type { Claims } from "./message.js";

export type TraceKind =
  /** A message put on a pipe. */
  | "published"
  /** Handed to a subscription's handler. */
  | "delivered"
  /** Not delivered: a `where` filter declined it. Never retried, never dead-lettered. */
  | "filtered"
  /** Not delivered: the deduplication key was already seen. */
  | "deduplicated"
  /** The handler ran and returned. */
  | "handled"
  /** Refused before the handler: a failed claim check or an invalid payload. Never retried. */
  | "rejected"
  /** The handler failed. Retried if the pipe's guarantee allows it. */
  | "failed"
  | "retrying"
  | "dead-lettered"
  /** Lost: an `at-most-once` pipe, so there is nowhere for it to go. */
  | "dropped"
  /** The clock moved. */
  | "advanced";

/** The closed set a `reason` may take, so `expect rejected ... reason x` can match. */
export type TraceReason =
  | "unauthorized"
  | "invalid"
  | "timeout"
  | "failed"
  | "duplicate"
  | "filtered"
  | "version"
  | "lossy"
  | "exhausted"
  | "discarded";

export interface TraceEvent {
  readonly at: VirtualTime;
  readonly iso: string;
  readonly seq: number;
  readonly kind: TraceKind;
  readonly message?: string;
  readonly pipe?: string;
  readonly service?: string;
  readonly subscription?: string;
  readonly id?: string;
  readonly correlation?: string;
  readonly attempt?: number;
  /**
   * A stable code, not prose: a scenario writes `reason unauthorized`, so this has
   * to be matchable. The prose goes in `detail`.
   */
  readonly reason?: TraceReason;
  readonly detail?: string;
  readonly envelope?: Readonly<Record<string, JsonValue>>;
  readonly body?: Readonly<Record<string, JsonValue>>;
  readonly claims?: Claims;
}

export class Trace {
  private readonly events: TraceEvent[] = [];
  private seq = 0;

  record(event: Omit<TraceEvent, "seq">): TraceEvent {
    const full: TraceEvent = { ...event, seq: this.seq++ };
    this.events.push(full);
    return full;
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  of(kind: TraceKind): readonly TraceEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /** NDJSON, one event per line. */
  toNdjson(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length > 0 ? "\n" : "");
  }

  /** A compact rendering for a terminal, which is what a first run wants. */
  toText(): string {
    return this.events
      .map((e) => {
        const where =
          e.pipe === undefined
            ? ""
            : e.subscription === undefined
              ? ` ${e.pipe}`
              : ` ${e.pipe} -> ${e.subscription}`;
        const extra = [
          e.message,
          e.attempt === undefined ? undefined : `attempt ${e.attempt}`,
          e.reason,
          e.detail,
        ]
          .filter((x) => x !== undefined)
          .join(" ");
        return `${String(e.at).padStart(14)}  ${e.kind.padEnd(13)} ${extra}${where}`;
      })
      .join("\n");
  }
}
