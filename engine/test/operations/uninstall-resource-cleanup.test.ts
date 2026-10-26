import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { makeCleanupDiscoveredApps } from "../../src/install/uninstall-discovery.ts";
import { uninstall } from "../../src/operations/uninstall.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

for (const scenario of [
  "volume",
  "container",
  "network",
  "unknown-usage",
  "missing-Containers",
  "missing-Local Volumes",
  "duplicate-Containers",
  "duplicate-Local Volumes",
  "unreachable",
  "clean",
] as const) {
  test(`managed ${scenario} cleanup gates subsequent machine, storage and state destruction`, async () => {
    // Given an owned installation with the reported managed resource usage.
    const roots = makeUninstallRoots("lando-uninstall-proof-");
    const mutations: string[] = [];
    const remaining = new Set([roots.userDataRoot, roots.userCacheRoot]);
    const calls: string[][] = [];
    const exec = async (file: string, args: readonly string[]) => {
      if (!file.startsWith(roots.userDataRoot)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      calls.push([...args]);
      if (args.includes("--version")) return { stdout: "podman" };
      if (scenario === "unreachable") throw new Error("runtime not answering");
      if (args.includes("df"))
        return {
          stdout:
            scenario === "unknown-usage"
              ? "{}"
              : JSON.stringify(
                  [
                    { Type: "Containers", Total: scenario === "container" ? 1 : 0 },
                    { Type: "Local Volumes", Total: scenario === "volume" ? 1 : 0 },
                  ]
                    .filter((row) => scenario !== `missing-${row.Type}`)
                    .flatMap((row) => (scenario === `duplicate-${row.Type}` ? [row, row] : [row])),
                ),
        };
      if (args.includes("network") && !args.includes("--filter"))
        return { stdout: scenario === "network" ? "unverified-network-id" : "" };
      return { stdout: "" };
    };
    try {
      // When explicit purge runs through resource cleanup.
      const result = await Effect.runPromise(
        uninstall({
          ...sandboxUninstallOptions(roots),
          purge: true,
          yes: true,
          listDiscoveredApps: async () => [],
          cleanupDiscoveredApps: makeCleanupDiscoveredApps(roots.userDataRoot, exec, "linux"),
          exists: (path) => remaining.has(path),
          readManagedProviderMachine: () => ({ ownership: "owned", name: "lando" }),
          teardownProviderMachines: async () => {
            mutations.push("machine");
            return { removed: true };
          },
          remove: async (path) => {
            mutations.push(path);
            remaining.delete(path);
          },
          terminateRuntimeBinProcesses: async () => {},
          teardownRuntimeService: async () => ({ terminated: true }),
        }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      // Then only verified zero counts allow owned machine and root cleanup.
      if (scenario === "clean" || scenario === "network") {
        expect(result.failed).toBe(false);
        expect(result.steps.find((step) => step.id === "running-apps")?.outcome).toBe("completed");
        expect(mutations).toContain("machine");
        expect(mutations).toContain(roots.userDataRoot);
        expect(mutations).toContain(roots.userCacheRoot);
      } else {
        expect(result.failed).toBe(true);
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0]).toMatchObject({ id: "running-apps", outcome: "failed" });
        expect(mutations).toEqual([]);
      }
      expect(
        calls.some((args) => args.includes("volume") && args.includes("ls") && !args.includes("--filter")),
      ).toBe(false);
      expect(calls.some((args) => args.includes("prune"))).toBe(false);
      expect(calls.some((args) => args.includes("network") && args.includes("rm"))).toBe(false);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });
}
