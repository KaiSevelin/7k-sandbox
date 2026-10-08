/**
 * Reading a host file, and starting what it names.
 *
 * The parsing half is about a file somebody edits by hand, so what matters is that a mistake in one
 * entry costs that entry and not the file. The starting half is about the two forms being genuinely
 * two: a module is imported into this process, a process is spawned and talked to, and a service the
 * file does not mention stays mocked rather than taking the run down.
 *
 * The process form is covered end to end by `process.test.ts` and, in another language entirely, by
 * the C# provider's `npm run devhost`. What is checked here is the wiring around it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHosts, readHosts, startHosts } from "../src/hosts.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sevenk-hosts-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("reading one", () => {
  it("reads both forms", () => {
    const { hosts, problems } = parseHosts(
      JSON.stringify({
        "shop.Desk": { run: "dotnet", args: ["run", "--project", "../Desk"], cwd: "src" },
        "shop.Picker": { module: "./picker.js", export: "pickerDevHost" },
      }),
      "hosts.json",
    );
    expect(problems).toEqual([]);
    expect(hosts.get("shop.Desk")).toEqual({
      run: "dotnet",
      args: ["run", "--project", "../Desk"],
      cwd: "src",
    });
    expect(hosts.get("shop.Picker")).toEqual({ module: "./picker.js", export: "pickerDevHost" });
  });

  /** One typo should cost one host. A file somebody edits by hand will have typos in it. */
  it("drops a bad entry and keeps the rest", () => {
    const { hosts, problems } = parseHosts(
      JSON.stringify({
        "shop.Desk": { run: "dotnet" },
        "shop.Broken": { runn: "dotnet" },
        "shop.AlsoBroken": "dotnet run",
      }),
      "hosts.json",
    );
    expect([...hosts.keys()]).toEqual(["shop.Desk"]);
    expect(problems.join(" | ")).toContain("shop.Broken");
    expect(problems.join(" | ")).toContain("shop.AlsoBroken");
    // In the file's own vocabulary, because the fix is to go and type one of those two words.
    expect(problems.join(" | ")).toContain("`run`");
    expect(problems.join(" | ")).toContain("`module`");
  });

  it("says so once when the whole file is unreadable", () => {
    const { hosts, problems } = parseHosts("{ not json", "hosts.json");
    expect(hosts.size).toBe(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is not JSON");
  });

  /** Having no host file is a state, not a fault: every service mocked is the default. */
  it("reads a file that is not there as an empty one", async () => {
    const read = await readHosts(join(dir, "nowhere", "hosts.json"));
    expect(read.hosts.size).toBe(0);
    expect(read.problems).toEqual([]);
  });
});

describe("starting them", () => {
  it("imports a module host, and resolves it against the file's own directory", async () => {
    await writeFile(
      join(dir, "picker.mjs"),
      "export const pickerDevHost = () => ({ reply: 'Picked' });\n",
      "utf-8",
    );
    await writeFile(
      join(dir, "hosts.json"),
      JSON.stringify({ "shop.Picker": { module: "./picker.mjs", export: "pickerDevHost" } }),
      "utf-8",
    );

    const read = await readHosts(join(dir, "hosts.json"));
    const started = await startHosts(read, ["shop.Picker"]);
    try {
      expect(started.problems).toEqual([]);
      const handler = started.live.get("shop.Picker");
      expect(typeof handler).toBe("function");
      expect(
        await handler!({
          envelope: { id: "1", type: "shop.Pick", time: 0, fields: {} },
          body: {},
          from: "scenario",
          claims: {},
        }),
      ).toEqual({ reply: "Picked" });
    } finally {
      await started.close();
    }
  });

  it("names the export it could not find rather than failing quietly", async () => {
    await writeFile(
      join(dir, "hosts.json"),
      JSON.stringify({ "shop.Picker": { module: "./picker.mjs", export: "nope" } }),
      "utf-8",
    );
    const started = await startHosts(await readHosts(join(dir, "hosts.json")), ["shop.Picker"]);
    await started.close();
    expect(started.live.size).toBe(0);
    expect(started.problems.join(" ")).toContain("`nope`");
  });

  /**
   * A host that will not start is dropped and named, and the run goes on with that service mocked.
   * The reverse takes down a run that would have told you about four other services.
   */
  it("keeps going when one host cannot be started", async () => {
    await writeFile(
      join(dir, "hosts.json"),
      JSON.stringify({
        "shop.Picker": { module: "./picker.mjs", export: "pickerDevHost" },
        "shop.Missing": { module: "./not-here.mjs" },
      }),
      "utf-8",
    );
    const started = await startHosts(await readHosts(join(dir, "hosts.json")), [
      "shop.Picker",
      "shop.Missing",
    ]);
    try {
      expect([...started.live.keys()]).toEqual(["shop.Picker"]);
      expect(started.problems.join(" ")).toContain("shop.Missing");
    } finally {
      await started.close();
    }
  });

  it("says when nothing in the file mentions a service it was asked for", async () => {
    await writeFile(join(dir, "hosts.json"), JSON.stringify({}), "utf-8");
    const started = await startHosts(await readHosts(join(dir, "hosts.json")), ["shop.Desk"]);
    await started.close();
    expect(started.problems.join(" ")).toContain("where it runs");
  });
});
