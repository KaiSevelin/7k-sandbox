/**
 * Where your code runs, as a file.
 *
 * The sandbox can already run a service for real: `live` takes a `Handler`, and three things satisfy
 * it — a mock, an in-process function, and `overProcess`, which speaks line-framed JSON to a child in
 * any language at all. What was missing was not a mechanism. It was somewhere to write down *which*
 * service is which, so that more than one thing could agree on the answer.
 *
 * **A file rather than a flag or a dialog.** Where your code lives is a fact about your checkout: it
 * changes rarely, it belongs in version control beside `layout.json` and `views.json`, and it has to
 * be readable by a command line and by CI and not only by a browser tab. A dialog would make whatever
 * had the dialog the only thing that knew.
 *
 * **Two forms, because there are two.** A process to spawn, which is how a language 7K has never
 * heard of joins in — this is what keeps D48 honest, since nothing here learns what C# is. And a
 * module to import, for a handler that is already JavaScript, where in-process means your debugger is
 * attached to the thing you are running rather than to its parent.
 *
 * ```json
 * {
 *   "shop.Desk":   { "run": "dotnet", "args": ["run", "--project", "../Desk"] },
 *   "shop.Picker": { "module": "./picker-host.ts", "export": "pickerDevHost" }
 * }
 * ```
 *
 * **Nothing here decides to run anything.** A host listed is a host that *could* be live; which ones
 * are is the runner's question, and `30-scenarios.md` section 4 is explicit that liveness is not part
 * of what a scenario claims. The same file therefore serves a fully mocked CI run, a one-service
 * development run and a conformance pass, which is the whole point of keeping it out of the scenario.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Handler } from "./engine.js";
import { overProcess } from "./process.js";

/** A child process speaking the development-host protocol over stdio. */
export interface ProcessHost {
  readonly run: string;
  readonly args?: readonly string[];
  /** Relative to the file this was read from, so a host file is portable between checkouts. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** How long to wait for the handshake. A `dotnet run` that has to build needs longer than a node. */
  readonly startupMs?: number;
}

/** A module exporting a `Handler`, imported into this process. */
export interface ModuleHost {
  readonly module: string;
  /** The export to use. `default` when not said. */
  readonly export?: string;
}

export type HostSpec = ProcessHost | ModuleHost;

export const isProcessHost = (host: HostSpec): host is ProcessHost => "run" in host;

export interface HostsFile {
  readonly file: string;
  readonly hosts: ReadonlyMap<string, HostSpec>;
  /** What could not be read, by service, so a bad entry does not cost the good ones. */
  readonly problems: readonly string[];
}

/** The name a host file is looked for under, beside the model. */
export const HOSTS = "hosts.json";

/**
 * Reads one, reporting rather than throwing.
 *
 * An entry that does not make sense is dropped and named. The alternative — refusing the file — means
 * one typo costs every host in it, which in a file somebody edits by hand is the wrong trade.
 */
export function parseHosts(text: string, file: string): HostsFile {
  const problems: string[] = [];
  const hosts = new Map<string, HostSpec>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      file,
      hosts,
      problems: [`${file} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { file, hosts, problems: [`${file} should be an object keyed by service name`] };
  }

  for (const [service, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`${service}: should be an object with \`run\` or \`module\``);
      continue;
    }
    const entry = raw as Record<string, unknown>;

    if (typeof entry.run === "string" && entry.run !== "") {
      if (entry.args !== undefined && !Array.isArray(entry.args)) {
        problems.push(`${service}: \`args\` should be a list of strings`);
        continue;
      }
      hosts.set(service, {
        run: entry.run,
        ...(entry.args === undefined ? {} : { args: (entry.args as unknown[]).map(String) }),
        ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
        ...(typeof entry.env === "object" && entry.env !== null
          ? { env: entry.env as Record<string, string> }
          : {}),
        ...(typeof entry.startupMs === "number" ? { startupMs: entry.startupMs } : {}),
      });
      continue;
    }

    if (typeof entry.module === "string" && entry.module !== "") {
      hosts.set(service, {
        module: entry.module,
        ...(typeof entry.export === "string" ? { export: entry.export } : {}),
      });
      continue;
    }

    // Said in the file's own vocabulary, because the fix is to go and type one of those two words.
    problems.push(`${service}: needs either \`run\` (a process) or \`module\` (something to import)`);
  }

  return { file, hosts, problems };
}

/** Reads one from disk, or an empty one where there is none — having no hosts is a state. */
export async function readHosts(file: string): Promise<HostsFile> {
  try {
    return parseHosts(await readFile(file, "utf-8"), file);
  } catch {
    return { file, hosts: new Map(), problems: [] };
  }
}

export interface Live {
  readonly live: ReadonlyMap<string, Handler>;
  /** What could not be started. The run goes ahead without them, mocked, and says so. */
  readonly problems: readonly string[];
  /** Shuts down every child this started. Always call it, including when the run threw. */
  close(): Promise<void>;
}

/**
 * Starts the hosts named, and hands back what the engine takes.
 *
 * **A host that will not start does not stop the run.** It is dropped, named, and that service stays
 * mocked — which is a scenario that still says something, rather than nothing. The reverse was tried
 * first and is worse: a project that does not build takes down a run that would have told you about
 * four other services.
 *
 * Paths resolve against the host file's own directory, so the file is portable between checkouts and
 * says what it means from where it sits.
 */
export async function startHosts(
  from: HostsFile,
  wanted: readonly string[],
  options: { readonly log?: (line: string) => void } = {},
): Promise<Live> {
  const root = dirname(resolve(from.file));
  const at = (path: string): string => (isAbsolute(path) ? path : resolve(root, path));

  const live = new Map<string, Handler>();
  const problems: string[] = [];
  const started: { close(): Promise<void> }[] = [];

  for (const service of wanted) {
    const host = from.hosts.get(service);
    if (host === undefined) {
      problems.push(`${service}: nothing in ${from.file} says where it runs`);
      continue;
    }

    try {
      if (isProcessHost(host)) {
        const handler = await overProcess(host.run, host.args ?? [], {
          cwd: at(host.cwd ?? "."),
          // Checked against the handshake, because launching the wrong host is a failure in which
          // everything still answers — with the wrong code.
          expect: service,
          ...(host.env === undefined ? {} : { env: host.env }),
          ...(host.startupMs === undefined ? {} : { startupMs: host.startupMs }),
          ...(options.log === undefined ? {} : { log: options.log }),
        });
        live.set(service, handler);
        started.push(handler);
        continue;
      }

      const loaded = (await import(pathToFileURL(at(host.module)).href)) as Record<string, unknown>;
      const name = host.export ?? "default";
      const found = loaded[name];
      if (typeof found !== "function") {
        problems.push(`${service}: ${host.module} exports no handler named \`${name}\``);
        continue;
      }
      live.set(service, found as Handler);
    } catch (cause) {
      problems.push(`${service}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return {
    live,
    problems,
    close: async () => {
      // Every one, whatever the others did: a child left running is a port held and a build lock kept.
      await Promise.all(started.map((one) => one.close().catch(() => undefined)));
    },
  };
}
