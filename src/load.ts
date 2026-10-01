/**
 * Getting from a path on disk to a judged run.
 *
 * A scenario file names a package but not the files that declare it, so running one
 * means loading the model around it. The rule is the one `7k check` already uses: a
 * scenario's directory and its ancestors up to the repository root are the workspace.
 * Making the author list the model files would be a second place to keep in step with
 * the imports they already wrote.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import {
  buildWorkspace,
  hasErrors,
  type Diagnostic,
  type LinkedModel,
  type ScenarioFile,
  type Workspace,
} from "@sevenk/core";
import type { Handler } from "./engine.js";
import { runFile, type FileResult, type RunOptions } from "./runner.js";

export interface LoadResult {
  readonly workspace: Workspace;
  readonly model: LinkedModel;
  /** The scenario files asked for, in the order given. */
  readonly scenarios: readonly ScenarioFile[];
  readonly diagnostics: readonly Diagnostic[];
}

const SKIP = new Set(["node_modules", ".git", "dist", "out", "coverage"]);

async function collect(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path, out);
    else if (entry.name.endsWith(".7k")) out.push(path);
  }
}

/**
 * Loads the model surrounding one or more scenario files.
 *
 * Every `.7k` file beside the scenario is parsed, because a scenario's package
 * imports others and those have to resolve. Unrelated files cost a parse and nothing
 * else — Core reports on them but a scenario never references them.
 */
export async function load(paths: readonly string[]): Promise<LoadResult> {
  const wanted = paths.map((p) => resolvePath(p));
  const roots = new Set(wanted.map((p) => dirname(p)));

  const found: string[] = [];
  for (const root of roots) await collect(root, found);

  const all = [...new Set([...found, ...wanted])].sort();
  const inputs = await Promise.all(
    all.map(async (path) => ({
      path: relative(process.cwd(), path).replaceAll("\\", "/"),
      source: await readFile(path, "utf8"),
    })),
  );

  const workspace = buildWorkspace(inputs);
  const requested = new Set(
    wanted.map((p) => relative(process.cwd(), p).replaceAll("\\", "/")),
  );

  // The order the caller asked for, so a report reads in the order of the command
  // line rather than in directory order.
  const scenarios = [...requested]
    .map((file) => workspace.scenarios.find((s) => s.file === file))
    .filter((s): s is ScenarioFile => s !== undefined);

  return {
    workspace,
    model: workspace.model,
    scenarios,
    diagnostics: workspace.diagnostics,
  };
}

export interface RunReport {
  readonly files: readonly FileResult[];
  readonly diagnostics: readonly Diagnostic[];
  /** Source text by path, so a diagnostic can be given a line and column. */
  readonly sources: ReadonlyMap<string, string>;
  /** True when the model itself does not check out, so nothing was run. */
  readonly blocked: boolean;
}

/**
 * Loads, checks, then runs.
 *
 * A model with errors is not run at all. A scenario executed against a model whose
 * names do not resolve would produce failures about the sandbox rather than about the
 * system, which is the least useful kind of red.
 */
export async function run(
  paths: readonly string[],
  options: RunOptions = {},
  live: ReadonlyMap<string, Handler> = new Map(),
): Promise<RunReport> {
  const loaded = await load(paths);

  const sources = new Map(loaded.workspace.model.files.map((f) => [f.path, f.source]));

  if (hasErrors(loaded.diagnostics)) {
    return { files: [], diagnostics: loaded.diagnostics, sources, blocked: true };
  }

  const files: FileResult[] = [];
  for (const file of loaded.scenarios) {
    files.push(await runFile(loaded.model, file, options, live));
  }

  return { files, diagnostics: loaded.diagnostics, sources, blocked: false };
}
