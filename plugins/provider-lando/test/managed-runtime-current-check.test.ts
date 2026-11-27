import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginDoctorCheckInput, PluginDoctorReport } from "@lando/sdk/plugins";
import { type DoctorCheckContractHarness, runDoctorCheckContractSuite } from "@lando/sdk/test";
import { Effect } from "effect";

import { makeManagedRuntimeCurrentCheck } from "../src/managed-runtime-current-check.ts";

interface Runtime {
  readonly installed?: string;
  readonly pinned: string;
  /** A running owned service: its launch record version and its scheduler acknowledgement. */
  readonly service?: { readonly recorded: string; readonly ack?: string };
}

const withRuntime = async <A>(runtime: Runtime, body: (input: PluginDoctorCheckInput) => Promise<A>) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-runtime-current-"));
  try {
    const binDir = join(userDataRoot, "runtime", "bin");
    const runDir = join(userDataRoot, "runtime", "run");
    await mkdir(binDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    if (runtime.installed !== undefined)
      await writeFile(join(binDir, ".runtime-installed-version"), `${runtime.installed}\n`);
    if (runtime.service !== undefined) {
      await writeFile(join(runDir, "podman.pid"), "4321");
      await writeFile(
        join(runDir, "podman.pid.launch.json"),
        JSON.stringify({ pid: 4321, env: {}, runtimeBundleVersion: runtime.service.recorded }),
      );
      if (runtime.service.ack !== undefined)
        await writeFile(join(runDir, "healthcheck-scheduler.pid"), runtime.service.ack);
    }
    return await body({
      providerId: "lando",
      platform: "linux",
      env: {},
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    });
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

const checkFor = (runtime: Runtime) => {
  const running = runtime.service !== undefined;
  return makeManagedRuntimeCurrentCheck({
    pinnedVersion: runtime.pinned,
    serviceRunner: {
      isAlive: () => Effect.succeed(running),
      isServiceProcess: () => Effect.succeed(running),
      isDescendant: (pid, ancestor) => Effect.succeed(pid === 4322 && ancestor === 4321),
    },
  });
};

const runCheck = (runtime: Runtime): Promise<ReadonlyArray<PluginDoctorReport>> =>
  withRuntime(runtime, (input) => Effect.runPromise(checkFor(runtime).run(input)));

describe("managed runtime current doctor check", () => {
  test("a runtime older than this build installs warns and points at setup", async () => {
    const [finding] = await runCheck({ installed: "0.1.8", pinned: "0.1.9" });
    expect(finding).toMatchObject({
      status: "warn",
      severity: "warn",
      context: { installedVersion: "0.1.8", pinnedVersion: "0.1.9", nativeHealthScheduling: "unavailable" },
    });
    expect(finding?.solutions[0]?.description).toContain("lando setup");
  });

  test("a current runtime that predates the scheduler passes and reports scheduling unavailable", async () => {
    const [finding] = await runCheck({ installed: "0.1.8", pinned: "0.1.8", service: { recorded: "0.1.8" } });
    expect(finding).toMatchObject({ status: "pass", context: { nativeHealthScheduling: "unavailable" } });
  });

  test("a scheduling service whose serving child acknowledged its scheduler passes", async () => {
    expect(
      await runCheck({ installed: "0.1.9", pinned: "0.1.9", service: { recorded: "0.1.9", ack: "4322\n" } }),
    ).toMatchObject([{ status: "pass", context: { nativeHealthScheduling: "scheduled" } }]);
  });

  test("with no service running the next launch schedules, so it passes", async () => {
    expect(await runCheck({ installed: "0.1.9", pinned: "0.1.9" })).toMatchObject([
      { status: "pass", context: { nativeHealthScheduling: "next-launch" } },
    ]);
  });

  test("a running service launched from an older runtime passes, because the next launch replaces it", async () => {
    expect(
      await runCheck({ installed: "0.1.9", pinned: "0.1.9", service: { recorded: "0.1.8", ack: "4321\n" } }),
    ).toMatchObject([{ status: "pass", context: { nativeHealthScheduling: "next-launch" } }]);
  });

  test("a service that opted in with no valid acknowledgement warns with the relaunch step", async () => {
    const [finding] = await runCheck({
      installed: "0.1.9",
      pinned: "0.1.9",
      service: { recorded: "0.1.9", ack: "999\n" },
    });
    expect(finding).toMatchObject({ status: "warn", context: { nativeHealthScheduling: "unacknowledged" } });
    expect(finding?.solutions[0]?.description).toContain("lando poweroff");
  });

  test("reports nothing without an installed runtime, off Linux, or for another provider", async () => {
    expect(await runCheck({ pinned: "0.1.9" })).toEqual([]);
    await withRuntime({ installed: "0.1.8", pinned: "0.1.9" }, async (input) => {
      const check = checkFor({ pinned: "0.1.9" });
      expect(await Effect.runPromise(check.run({ ...input, platform: "darwin" }))).toEqual([]);
      expect(await Effect.runPromise(check.run({ ...input, providerId: "docker" }))).toEqual([]);
    });
  });
});

describe("DoctorCheck contract: managed-runtime-current", () => {
  const snapshotTree = async (root: string): Promise<string> => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = join(entry.parentPath, entry.name);
          return `${path}:${await readFile(path, "utf8")}`;
        }),
    );
    return files.sort().join("\n");
  };

  const contract = (runtime: Runtime, expectedIssue?: DoctorCheckContractHarness["expectedIssue"]) =>
    withRuntime(runtime, async (input) => {
      const root = input.userDataRoot ?? "";
      const check = checkFor(runtime);
      const harness: DoctorCheckContractHarness = {
        name: "managed-runtime-current",
        check: {
          id: check.id,
          run: () =>
            check.run(input).pipe(
              Effect.map((reports) => ({
                id: check.id,
                issues: reports.flatMap((report) =>
                  report.solutions.map((solution) => ({
                    severity: report.severity === "warn" ? ("warning" as const) : report.severity,
                    context: Object.fromEntries(
                      Object.entries(report.context).map(([key, value]) => [
                        key,
                        typeof value === "string" ? value : value.join(", "),
                      ]),
                    ),
                    solutionKind: solution.kind,
                    solution: solution.description,
                  })),
                ),
              })),
            ),
        },
        ...(expectedIssue === undefined ? {} : { expectedIssue }),
        readOnlyProbe: {
          snapshot: Effect.promise(() => snapshotTree(root)),
          assertUnchanged: (before) => Effect.promise(async () => (await snapshotTree(root)) === before),
        },
      };
      return Effect.runPromiseExit(runDoctorCheckContractSuite(harness));
    });

  test("a current scheduling runtime satisfies the contract with no issues", async () => {
    const exit = await contract({
      installed: "0.1.9",
      pinned: "0.1.9",
      service: { recorded: "0.1.9", ack: "4321\n" },
    });
    expect(exit._tag).toBe("Success");
  });

  test("an outdated runtime reports a read-only manual warning", async () => {
    const exit = await contract(
      { installed: "0.1.8", pinned: "0.1.9" },
      { severity: "warning", contextKey: "installedVersion", solutionKind: "manual" },
    );
    expect(exit._tag).toBe("Success");
  });
});
