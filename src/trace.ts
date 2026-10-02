/**
 * Collecting a trace.
 *
 * The **format** is not this file's business any more. It is one of 7K's published interchange
 * artifacts (`docs/spec/30-scenarios.md` section 7), defined in `@sevenk/core` so that a writer and a
 * reader import the same thing — and it lives there rather than here because the sandbox is one
 * producer among several, and a format owned by one of its producers drifts toward that producer
 * (D93).
 *
 * It drifted exactly that way while it lived here: `service` was written bare while everything else
 * was qualified, `correlation` was declared and never emitted, `seq` restarted per run so a file of
 * two runs had two events numbered 0, and the key order was whichever branch happened to build the
 * object. Spider, the first consumer, had to read this file to learn any of it.
 *
 * What is left here is what a runtime genuinely owns: gathering events in order, and rendering them
 * for a terminal.
 */

import { writeTrace, type TraceEvent, type TraceKind } from "@sevenk/core";

export type { TraceEvent, TraceKind, TraceReason } from "@sevenk/core";

export class Trace {
  private readonly events: TraceEvent[] = [];
  private seq = 0;

  /**
   * @param run identifies this trace among others in one file. It carries the scenario and the seed,
   * because that pair is the whole of what a failure is: a model plus a number.
   */
  constructor(readonly run: string) {}

  record(event: Omit<TraceEvent, "seq" | "run">): TraceEvent {
    const full: TraceEvent = { ...event, run: this.run, seq: this.seq++ };
    this.events.push(full);
    return full;
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  of(kind: TraceKind): readonly TraceEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /** NDJSON, per section 7: Core writes it, so the field order and the bytes are the format's. */
  toNdjson(): string {
    return writeTrace(this.events);
  }

  /** A compact rendering for a terminal, which is what a first run wants. */
  toText(): string {
    return this.events
      .map((e) => {
        const where =
          e.saga !== undefined
            ? ` ${e.saga}["${e.sagaKey ?? ""}"]`
            : e.schedule !== undefined
              ? ` ${e.schedule}`
              : e.pipe === undefined
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
        return `${String(e.at).padStart(14)}  ${e.kind.padEnd(19)} ${extra}${where}`;
      })
      .join("\n");
  }
}
