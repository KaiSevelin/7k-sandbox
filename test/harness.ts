/**
 * Test support: building a model and a scenario from inline 7K source.
 *
 * Inline source rather than a hand-built IR, deliberately. A test that constructed
 * the IR by hand would pass even if the parser or the lowering disagreed with it,
 * which is exactly the class of divergence this package exists to avoid.
 */

import { buildWorkspace, hasErrors, type LinkedModel, type Scenario, type ScenarioFile } from "@sevenk/core";
import { expect } from "vitest";
import { runScenario, type RunOptions, type ScenarioResult } from "../src/runner.js";

export interface Built {
  readonly model: LinkedModel;
  readonly file: ScenarioFile;
  readonly scenarios: readonly Scenario[];
}

/** Builds a model plus one scenario file, failing the test if either does not check out. */
export function build(model: string, scenarios: string): Built {
  const workspace = buildWorkspace([
    { path: "model.7k", source: model },
    { path: "test.scenario.7k", source: scenarios },
  ]);

  const errors = workspace.diagnostics.filter((d) => d.severity === "error");
  expect(
    errors.map((d) => `${d.span.file}: ${d.code}: ${d.message}`),
    "the test's own 7K source must check out",
  ).toEqual([]);
  expect(hasErrors(workspace.diagnostics)).toBe(false);

  const file = workspace.scenarios[0];
  if (file === undefined) throw new Error("no scenario file was lowered");

  return { model: workspace.model, file, scenarios: file.scenarios };
}

/** Builds and runs one named scenario. */
export async function run(
  model: string,
  scenarios: string,
  name?: string,
  options: RunOptions = {},
): Promise<ScenarioResult> {
  const built = build(model, scenarios);
  const scenario =
    name === undefined ? built.scenarios[0] : built.scenarios.find((s) => s.name === name);
  if (scenario === undefined) throw new Error(`no scenario named ${name ?? "(first)"}`);
  return runScenario(built.model, built.file, scenario, options);
}

/** The trace's event kinds in order, which is what most behaviour assertions are about. */
export const kinds = (result: ScenarioResult): string[] =>
  result.trace
    .all()
    .filter((e) => e.kind !== "advanced")
    .map((e) => e.kind);

export const countOf = (result: ScenarioResult, kind: string): number =>
  result.trace.all().filter((e) => e.kind === kind).length;
