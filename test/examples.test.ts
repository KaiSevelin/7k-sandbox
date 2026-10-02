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
    expect(results).toHaveLength(8);

    const failures = results
      .filter((r) => r.status !== "pass")
      .map((r) => `${r.name}: ${r.errors.join("; ")} ${r.assertions
        .filter((a) => a.status !== "pass")
        .map((a) => `${a.text} -> ${a.detail ?? a.status}`)
        .join("; ")}`);

    expect(failures).toEqual([]);
  });

  it("applies the upcast sales.7k declares, which nothing exercised before", async () => {
    const report = await run([resolve(EXAMPLES, "soldout.scenario.7k")]);
    const upcasting = report.files
      .flatMap((f) => f.scenarios)
      .find((s) => s.name === "OldOrderPlacedUpcasts")!;

    expect(upcasting.status).toBe("pass");
    expect(upcasting.trace.of("upcast").map((e) => e.detail)).toEqual(["v1.0 to v1.1"]);
    // `note = absent` leaves the key out, and the v1.0 shape never had it.
    expect(upcasting.trace.of("upcast")[0]?.body).not.toHaveProperty("note");
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

  it("runs the shop's sagas green, both directions of the compensation pair", async () => {
    const report = await run([resolve(EXAMPLES, "shop.scenario.7k")]);
    const results = report.files.flatMap((f) => f.scenarios);

    const failures = results
      .filter((r) => r.status !== "pass")
      .map((r) => `${r.name}: ${r.errors.join("; ")} ${r.assertions
        .filter((a) => a.status !== "pass")
        .map((a) => `${a.text} -> ${a.detail ?? a.status}`)
        .join("; ")}`);
    expect(failures).toEqual([]);
    expect(results).toHaveLength(8);

    // The pair that makes a saga trustworthy: compensation runs for a step that completed
    // and must not run for one that did not (`04-process.md` 1.4).
    const refunded = results.find((r) => r.name === "ShipmentRejectedRefundsCharge")!;
    const declined = results.find((r) => r.name === "CardDeclinedRefundsNothing")!;
    expect(refunded.trace.of("saga-compensating").map((e) => e.message)).toEqual([
      "acme.shop.RefundCard",
    ]);
    expect(declined.trace.of("saga-compensating")).toEqual([]);
  });

  it("drives the shop's nightly schedule, overrun and catch-up included", async () => {
    const report = await run([resolve(EXAMPLES, "shop.scenario.7k")]);
    const results = report.files.flatMap((f) => f.scenarios);

    const nightly = results.find((r) => r.name === "NightlyCloseRunsEachDay")!;
    expect(nightly.status).toBe("pass");
    expect(nightly.trace.of("schedule-fired")).toHaveLength(3);
    expect(nightly.trace.of("schedule-overrun")).toEqual([]);

    // A close still retrying when the next is due: the occurrence is missed, and
    // `onMissed all` works through the backlog rather than losing a day's settlement.
    const slow = results.find((r) => r.name === "SlowCloseBacksUp")!;
    expect(slow.status).toBe("pass");
    expect(slow.trace.of("schedule-overrun")).toHaveLength(1);
    expect(slow.trace.of("schedule-missed").map((e) => e.detail)).toEqual([
      "1 missed, onMissed all",
    ]);
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
