#!/usr/bin/env node
/**
 * `7k-sandbox` — run 7K scenarios against a model.
 *
 *   7k-sandbox run checkout.scenario.7k
 *   7k-sandbox run examples/*.scenario.7k --soaks
 *   7k-sandbox run checkout.scenario.7k --live PaymentService --handlers ./handlers.js
 *   7k-sandbox trace checkout.scenario.7k --scenario SeatsSoldOut
 *
 * Liveness is a flag rather than something written in the scenario. A scenario is a
 * falsifiable claim about the system (D60); whether a given service is a real handler
 * is not part of the claim, it is the fidelity at which the claim is being checked. So
 * the same file runs fully mocked in CI, with one service live in development, and
 * against a real deployment in the conformance pass — one suite at three fidelities
 * rather than three suites.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { formatDiagnostic, hasErrors } from "@sevenk/core";
import type { Handler } from "./engine.js";
import { run } from "./load.js";
import type { ScenarioResult } from "./runner.js";

interface Options {
  readonly command: "run" | "trace" | "help";
  readonly paths: readonly string[];
  readonly live: readonly string[];
  readonly handlers?: string;
  readonly only?: string;
  readonly seed?: number;
  readonly soaks: boolean;
  readonly chaos: boolean;
  readonly ackTimeoutMs?: number;
  readonly ndjson: boolean;
  readonly verbose: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const paths: string[] = [];
  const live: string[] = [];
  let command: Options["command"] = "help";
  let handlers: string | undefined;
  let only: string | undefined;
  let seed: number | undefined;
  let ackTimeoutMs: number | undefined;
  let soaks = false;
  let chaos = false;
  let ndjson = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "run":
      case "trace":
        command = arg;
        break;
      case "help":
      case "--help":
      case "-h":
        command = "help";
        break;
      case "--live":
        live.push(argv[++i] ?? "");
        break;
      case "--handlers":
        handlers = argv[++i];
        break;
      case "--scenario":
        only = argv[++i];
        break;
      case "--seed":
        seed = Number(argv[++i]);
        break;
      case "--ack-timeout":
        ackTimeoutMs = Number(argv[++i]);
        break;
      case "--soaks":
        soaks = true;
        break;
      case "--chaos":
        chaos = true;
        break;
      case "--ndjson":
        ndjson = true;
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      default:
        if (!arg.startsWith("-")) paths.push(arg);
        break;
    }
  }

  return {
    command,
    paths,
    live,
    ...(handlers === undefined ? {} : { handlers }),
    ...(only === undefined ? {} : { only }),
    ...(seed === undefined || Number.isNaN(seed) ? {} : { seed }),
    ...(ackTimeoutMs === undefined || Number.isNaN(ackTimeoutMs) ? {} : { ackTimeoutMs }),
    soaks,
    chaos,
    ndjson,
    verbose,
  };
}

const USAGE = `7k-sandbox - run 7K scenarios against a model

  7k-sandbox run <scenario.7k>...     run the scenarios in each file
  7k-sandbox trace <scenario.7k>...   run and print the trace

Options
  --scenario <Name>     run only this scenario
  --live <Service>      run this service's real handler instead of its mock
  --handlers <module>   where to import live handlers from (default ./handlers.js)
  --seed <n>            override every scenario's seed
  --ack-timeout <ms>    how long an unacknowledged delivery waits (default 5000)
  --soaks               run soak declarations as well
  --chaos               inject the loss and reordering each pipe's guarantee permits
  --ndjson              print the trace as NDJSON rather than as a table
  --verbose             print the trace for passing scenarios too
`;

/**
 * Loads live handlers.
 *
 * A module exporting a function per service name. Deliberately plain: the handler
 * signature is the one a generated wrapper calls, so nothing here knows about this
 * sandbox and the same handler runs unchanged in production.
 */
async function loadHandlers(
  module: string | undefined,
  wanted: readonly string[],
): Promise<{ handlers: Map<string, Handler>; errors: string[] }> {
  const handlers = new Map<string, Handler>();
  const errors: string[] = [];
  if (wanted.length === 0) return { handlers, errors };

  const path = module ?? "./handlers.js";
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  } catch (error) {
    errors.push(
      `--live was given but ${path} could not be imported: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { handlers, errors };
  }

  const bag = (loaded.default ?? loaded) as Record<string, unknown>;
  for (const name of wanted) {
    const found = bag[name] ?? (loaded as Record<string, unknown>)[name];
    if (typeof found === "function") handlers.set(name, found as Handler);
    else errors.push(`${path} exports no handler named \`${name}\``);
  }

  return { handlers, errors };
}

const ICON: Record<ScenarioResult["status"], string> = {
  pass: "ok  ",
  fail: "FAIL",
  unsupported: "?   ",
};

function report(result: ScenarioResult, options: Options): string[] {
  const lines = [
    `${ICON[result.status]} ${result.kind} ${result.name}` +
      `  (seed ${result.seed}, ${formatMs(result.elapsedMs)} virtual)`,
  ];

  for (const error of result.errors) lines.push(`       ! ${error}`);

  for (const assertion of result.assertions) {
    if (assertion.status === "pass" && !options.verbose) continue;
    const mark = assertion.status === "pass" ? "·" : assertion.status === "fail" ? "x" : "?";
    lines.push(
      `       ${mark} ${assertion.text}` +
        (assertion.detail === undefined ? "" : ` - ${assertion.detail}`),
    );
  }

  // Notes are about the model, not about the assertion, so they are printed whether
  // or not the scenario passed: a queue with competing consumers is worth knowing
  // about even on a green run.
  for (const note of result.notes) lines.push(`       note: ${note}`);

  return lines;
}

const formatMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
};

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "help" || options.paths.length === 0) {
    process.stdout.write(USAGE);
    return options.command === "help" ? 0 : 1;
  }

  const { handlers, errors } = await loadHandlers(options.handlers, options.live);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.length > 0) return 1;

  const report_ = await run(
    options.paths,
    {
      soaks: options.soaks,
      chaos: options.chaos,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
    },
    handlers,
  );

  // Diagnostics first, always: a warning about the model is the most likely
  // explanation for a surprising run.
  for (const diagnostic of report_.diagnostics) {
    process.stderr.write(`${formatDiagnostic(diagnostic, report_.sources.get(diagnostic.span.file) ?? "")}\n`);
  }

  if (report_.blocked) {
    process.stderr.write("\nthe model does not check out, so nothing was run\n");
    return 1;
  }

  let failed = 0;
  let passed = 0;
  let unsupported = 0;

  for (const file of report_.files) {
    const scenarios = file.scenarios.filter(
      (s) => options.only === undefined || s.name === options.only,
    );
    if (scenarios.length === 0) continue;

    process.stdout.write(`\n${file.file}  (${file.package})\n`);

    for (const result of scenarios) {
      process.stdout.write(`${report(result, options).join("\n")}\n`);

      if (result.status === "fail") failed++;
      else if (result.status === "unsupported") unsupported++;
      else passed++;

      const wantTrace =
        options.command === "trace" || (result.status === "fail" && !options.ndjson);
      if (!wantTrace) continue;

      process.stdout.write(
        options.ndjson
          ? result.trace.toNdjson()
          : `${indent(result.trace.toText())}\n`,
      );
    }
  }

  const summary = [
    `${passed} passed`,
    failed > 0 ? `${failed} failed` : undefined,
    unsupported > 0 ? `${unsupported} not fully checked` : undefined,
  ].filter((s) => s !== undefined);

  process.stdout.write(`\n${summary.join(", ")}\n`);
  return failed > 0 ? 1 : 0;
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(2);
  },
);
