/**
 * A live handler that is somebody else's process.
 *
 * `Handler` lets one service in a scenario run for real while its collaborators stay mocked. This is
 * that, across a process boundary — so the service running for real can be written in a language this
 * runtime has never heard of, and can be sitting under its own debugger while the rest of the system is
 * simulated.
 *
 * **Why this is better than a real broker for the purpose, and it is not close.** The clock is virtual,
 * so no wall-clock time passes while the engine awaits a reply. Stopping on a breakpoint for five
 * minutes does not trip a step's `timeout 30s`, because as far as the model is concerned no time has
 * gone by. Against a real broker the visibility timeout expires and the message is redelivered while
 * you are still reading a local, which is why debugging a saga against one is an exercise in frustration
 * rather than an exercise in debugging.
 *
 * **The protocol lives here and not in a provider**, because it is `Handler` serialised and the
 * `Handler` contract is this package's. A provider that defined its own frame format would be a second
 * definition of a thing with one meaning, and the first time a second language was adapted the two
 * would drift — which is the same reason the trace format is specified centrally instead of being left
 * to each runtime. A language's adapter implements the other end of *this*; it does not invent an end.
 *
 * **Line-framed JSON over stdio, not HTTP.** No port to choose, no firewall to placate, no
 * authentication to get wrong, and the process is one the developer launched — so a debugger is already
 * attached to it. The cost is that the child's stdout is now a protocol channel, which is a real hazard
 * and handled below rather than hoped about.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonValue } from "@sevenk/core";
import type { Handler, HandlerResult } from "./engine.js";
import type { Message } from "./message.js";

/**
 * One delivery, as it crosses.
 *
 * **Exactly the handler's parameters, and nothing else.** A generated handler is handed the message,
 * its envelope fields and a cancellation token — so that is what goes over, and the things a `Message`
 * also carries deliberately do not:
 *
 * - **No claims.** `requires` was decided before dispatch. Sending them would invite a handler to
 *   decide authorization a second time and differently, which is the one thing D48 forbids.
 * - **No sender, and no pipe.** The subscription already decided which handler this is. A handler that
 *   could read either could branch on it, and nothing in the model says it may.
 * - **No envelope `id` or `time`.** Per-send identity and the clock are the runtime's, not the
 *   handler's; a handler that read the clock would be one whose behaviour depends on how it was run.
 *
 * The rule is worth stating because it is the whole of the design: anything added here is something a
 * handler could branch on that the model does not authorize.
 */
export interface Delivery {
  /** Correlates the result. Monotonic per process, and echoed back unchanged. */
  readonly id: number;
  /** The message's qualified name: `acme.flow.desk.Submit`. */
  readonly type: string;
  /** The version as delivered, after any `upcast` the engine applied. */
  readonly version?: string;
  readonly body: Readonly<Record<string, JsonValue>>;
  /** The declared envelope records, flattened as D50 flattens them. */
  readonly envelope: Readonly<Record<string, JsonValue>>;
}

/**
 * What comes back.
 *
 * Two shapes, because a handler has two outcomes the model knows about: it handled the message, with or
 * without one of its declared replies, or it failed.
 *
 * **A failure is not a reply.** D26 reads "the gateway timed out" and "the database deadlocked" as the
 * same observable *from the conversation's point of view*, so what must never happen is that the cause
 * arrives as something another service can see or branch on. `failed` carries a string anyway, and it
 * goes where a person reading the run will find it — a trace is not the conversation, and a debugger
 * with no idea why a handler failed is a debugger nobody uses. The engine then retries under the
 * pipe's own policy, which is what a production wrapper would have done.
 */
export type Outcome =
  | {
      readonly id: number;
      readonly handled: true;
      /** One of the subscription's declared replies, qualified. Absent for `replies none`. */
      readonly reply?: string;
      readonly body?: Readonly<Record<string, JsonValue>>;
    }
  | { readonly id: number; readonly failed: string };

/** The first line a host writes: which service it is. */
export interface Ready {
  readonly ready: string;
}

/**
 * A `Handler` backed by a child process, with a way to shut it down.
 *
 * Callable, so it drops straight into `live` without unwrapping: `new Map([["Desk", desk]])`.
 */
export interface ProcessHandler {
  (message: Message): Promise<HandlerResult>;
  /** The service the host said it was. */
  readonly service: string;
  /** Closes stdin and waits for the child. Idempotent. */
  close(): Promise<void>;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The service this host is expected to be, checked against its handshake.
   *
   * Worth checking because the failure it catches is quiet and confusing: register `Desk` in `live`,
   * launch the `Ledger` host by mistake, and every delivery is answered by the wrong code.
   */
  readonly expect?: string;
  /** How long to wait for the handshake. Nothing else has a deadline — see `handle`. */
  readonly startupMs?: number;
  /** Where the child's own output goes. Defaults to this process's stderr. */
  readonly log?: (line: string) => void;
}

/**
 * Spawns a host and returns it as a `Handler`.
 *
 * Resolves once the child has introduced itself, so a command that does not exist or a project that
 * does not build fails here rather than on the first delivery — where it would look like a model
 * problem.
 */
export async function overProcess(
  command: string,
  args: readonly string[] = [],
  options: ProcessOptions = {},
): Promise<ProcessHandler> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const say = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const pending = new Map<number, { resolve: (o: HandlerResult) => void; reject: (e: Error) => void }>();
  let next = 1;
  let introduced: ((name: string) => void) | undefined;
  let failed: Error | undefined;
  let closed = false;

  /** Rejects everything outstanding. A child that has gone will not be answering. */
  const abandon = (why: Error): void => {
    failed = why;
    for (const [, one] of pending) one.reject(why);
    pending.clear();
  };

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim() !== "") say(`${command}: ${line}`);
  });

  child.stdout.setEncoding("utf-8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === "") continue;
      take(line);
    }
  });

  const take = (line: string): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // The child printed something that is not a frame. Its stdout is a protocol channel, and a
      // `println` in a handler is the most ordinary thing in the world — so this is reported as the
      // child's own output rather than treated as a protocol fault. A host should redirect its
      // standard output on the way up; this is what happens when one has not.
      say(`${command}: ${line}`);
      return;
    }

    if (typeof frame !== "object" || frame === null) {
      say(`${command}: ${line}`);
      return;
    }

    const ready = (frame as Partial<Ready>).ready;
    if (typeof ready === "string") {
      introduced?.(ready);
      return;
    }

    // Read as the untrusted thing it is: a frame from another process, which may be any shape at all.
    const outcome = frame as {
      readonly id?: unknown;
      readonly failed?: unknown;
      readonly reply?: unknown;
      readonly body?: unknown;
    };
    const id = typeof outcome.id === "number" ? outcome.id : undefined;
    if (id === undefined) {
      say(`${command}: a frame with no id: ${line}`);
      return;
    }
    const one = pending.get(id);
    if (one === undefined) {
      say(`${command}: an answer to nothing (${id})`);
      return;
    }
    pending.delete(id);

    if (typeof outcome.failed === "string") {
      // Thrown rather than returned, because that is how the engine already reads a live handler's
      // failure — `runLive` catches and routes it through the pipe's retry policy. One path.
      one.reject(new Error(outcome.failed));
      return;
    }
    one.resolve({
      ...(typeof outcome.reply === "string" ? { reply: outcome.reply } : {}),
      ...(typeof outcome.body === "object" && outcome.body !== null
        ? { body: outcome.body as Readonly<Record<string, JsonValue>> }
        : {}),
    });
  };

  child.on("error", (error) => {
    abandon(new Error(`${command} could not be run: ${error.message}`));
  });
  child.on("exit", (code, signal) => {
    if (closed) return;
    abandon(
      new Error(
        `${command} exited ${signal === null ? `with code ${code ?? "?"}` : `on ${signal}`} ` +
          "while a delivery was outstanding",
      ),
    );
  });

  const service = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${command} did not say what service it is within ${options.startupMs ?? 20_000}ms`));
    }, options.startupMs ?? 20_000);
    introduced = (name) => {
      clearTimeout(timer);
      resolve(name);
    };
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`${command} exited before saying what service it is`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} could not be run: ${error.message}`));
    });
  });

  if (options.expect !== undefined && options.expect !== service) {
    child.kill();
    throw new Error(`expected a host for \`${options.expect}\`, but \`${command}\` is \`${service}\``);
  }

  /**
   * One delivery, awaited.
   *
   * **No deadline, deliberately.** A handler stopped on a breakpoint is the point of this, and a
   * timeout here would be a wall-clock deadline reintroduced into a virtual-clock runtime — the exact
   * thing a real broker gets wrong. What is bounded instead is the child's existence: if it exits or
   * cannot be run, everything outstanding is rejected at once rather than waiting forever.
   */
  const handle = async (message: Message): Promise<HandlerResult> => {
    if (failed !== undefined) throw failed;
    const id = next++;
    const delivery: Delivery = {
      id,
      type: message.envelope.type,
      ...(message.envelope.version === undefined ? {} : { version: message.envelope.version }),
      body: message.body,
      envelope: message.envelope.fields,
    };
    const answer = new Promise<HandlerResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(delivery)}\n`);
    return answer;
  };

  const handler = handle as unknown as {
    (message: Message): Promise<HandlerResult>;
    service: string;
    close(): Promise<void>;
  };
  handler.service = service;
  handler.close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    abandon(new Error(`${command} was closed`));
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      // A host that is not reading stdin, or is stopped in a debugger, will not notice the end of it.
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  };

  return handler as ProcessHandler;
}

/** A `Handler` and nothing else, for somewhere that does not want the extras. */
export const asHandler = (one: ProcessHandler): Handler => (message) => one(message);
