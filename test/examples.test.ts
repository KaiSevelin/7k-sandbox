/**
 * The examples in the 7K repository, actually run.
 *
 * This is the sandbox's corpus test, and it is the reason the examples are trustworthy
 * at all. `7k check` proves they parse and resolve; only running them proves the
 * behaviour they assert is the behaviour they get. Every defect found while building
 * this runtime was an example that checked out and was still wrong.
 *
 * Skipped rather than failed when the 7K repository is not beside this one, since the
 * dependency is a sibling checkout and not something npm installs.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/load.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "7K", "examples");
const present = existsSync(EXAMPLES);

describe.skipIf(!present)("the 7K examples", () => {
  it("runs every sold-out scenario green, soaks included", async () => {
    const report = await run([resolve(EXAMPLES, "soldout.scenario.7k")], { soaks: true });

    expect(report.blocked).toBe(false);
    const results = report.files.flatMap((f) => f.scenarios);
    expect(results).toHaveLength(7);

    const failures = results
      .filter((r) => r.status !== "pass")
      .map((r) => `${r.name}: ${r.errors.join("; ")} ${r.assertions
        .filter((a) => a.status !== "pass")
        .map((a) => `${a.text} -> ${a.detail ?? a.status}`)
        .join("; ")}`);

    expect(failures).toEqual([]);
  });

  it("holds an hour of simulated load without waiting for it", async () => {
    const started = Date.now();
    const report = await run([resolve(EXAMPLES, "soldout.scenario.7k")], { soaks: true });
    const soak = report.files[0]?.scenarios.find((s) => s.kind === "soak");

    expect(soak?.status).toBe("pass");
    // An hour of load, plus however long the last reply in flight took to land: the
    // run ends when nothing is pending, not when the last message was sent.
    expect(soak?.elapsedMs).toBeGreaterThanOrEqual(3_600_000);
    expect(soak?.elapsedMs).toBeLessThan(3_600_000 + 60_000);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("reports the shop's saga scenarios as unchecked rather than as failures", async () => {
    const report = await run([resolve(EXAMPLES, "shop.scenario.7k")]);
    const results = report.files.flatMap((f) => f.scenarios);

    // Sagas are the Process layer, and this runtime stops at Topology. Saying so is
    // the point: an assertion that silently passed would be worse than a red one.
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.filter((r) => r.status === "unsupported").map((r) => r.name)).toEqual([
      "CheckoutSucceeds",
      "CardDeclinedRefundsNothing",
      "ShipmentRejectedRefundsCharge",
      "PaymentNeverAnswers",
      "DuplicatePlaceOrder",
    ]);

    // The one scenario that is purely about the Topology layer is judged for real.
    const authorization = results.find((r) => r.name === "PlaceOrderForSomeoneElse");
    expect(authorization?.status).toBe("pass");
  });

  it("produces a trace that is identical across runs, so a seed is a bug report", async () => {
    const once = async (): Promise<string> => {
      const report = await run([resolve(EXAMPLES, "soldout.scenario.7k")]);
      return report.files
        .flatMap((f) => f.scenarios)
        .map((s) => s.trace.toNdjson())
        .join("");
    };

    expect(await once()).toBe(await once());
  });
});
