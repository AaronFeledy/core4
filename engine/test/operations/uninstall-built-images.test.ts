import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preflightDataRootPurge } from "@lando/container-runtime/data-root-purge";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import type { ProviderPurgeHook } from "@lando/sdk/plugins";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { makePrepareUninstallCleanup } from "../../src/install/uninstall-discovery.ts";
import { uninstall } from "../../src/operations/uninstall.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

test.each(["clean", "foreign", "in-use", "failed", "listing-failed", "dry-run", "keep-data"] as const)(
  "#2379 uninstall preserves recovery state until image cleanup succeeds: %s",
  async (scenario) => {
    const roots = makeUninstallRoots("lando-uninstall-images-");
    const recovery = join(roots.userCacheRoot, "artifact-build-results.bin");
    mkdirSync(roots.userCacheRoot);
    writeFileSync(recovery, "recovery index");
    let present = true;
    let probeCount = 0;
    const purge: ProviderPurgeHook = (input) => {
      const tag = `docker.io/library/lando-build-${input.buildStore}-example:latest`;
      const api: EngineHttpApi = {
        request: ({ method, path }) =>
          Effect.sync(() => {
            const json = (value: unknown, status = 200) => ({ status, body: JSON.stringify(value) });
            if (path === "/_ping") {
              probeCount++;
              return json(null);
            }
            if (path.startsWith("/volumes?")) return json({ Volumes: [] });
            if (path.startsWith("/containers/json"))
              return json(
                scenario === "in-use" && decodeURIComponent(path).includes("ancestor")
                  ? [{ Id: "peer" }]
                  : [],
              );
            if (path.startsWith("/networks?")) return json([]);
            if (path.startsWith("/images/json")) {
              if (scenario === "listing-failed") return json({ message: "image listing failed" }, 500);
              return json(
                present && decodeURIComponent(path).includes(`dev.lando.build-store=${input.buildStore}`)
                  ? [{ Id: "sha256:owned" }]
                  : [],
              );
            }
            if (path.startsWith("/images/") && method === "GET")
              return json({
                Id: "owned",
                RepoTags: scenario === "foreign" ? [tag, "user/app:latest"] : [tag],
                Config: { Labels: { "dev.lando.build-store": input.buildStore } },
              });
            if (method === "DELETE" && path === `/images/${encodeURIComponent(tag)}?noprune=true`) {
              if (!existsSync(recovery)) throw new Error("Deleted cache before store images");
              if (scenario === "failed") return json({ message: "storage write failed" }, 500);
              present = false;
              return json([]);
            }
            throw new Error(`Unexpected fixture request ${method} ${path}`);
          }),
      };
      return preflightDataRootPurge(
        api,
        { providerId: "podman", remediation: "Retry", env: {} },
        { ...input, endpoint: "/fixture.sock", pluginId: "@lando/provider-podman" },
      );
    };
    try {
      const prepareResourceCleanup = makePrepareUninstallCleanup(
        [{ providerId: "podman", purge }],
        async () => {
          throw Object.assign(new Error("managed runtime not installed"), { code: "ENOENT" });
        },
        "linux",
      );
      const result = await Effect.runPromise(
        uninstall({
          ...sandboxUninstallOptions(roots),
          prepareResourceCleanup,
          yes: true,
          purge: scenario !== "keep-data",
          dryRun: scenario === "dry-run",
        }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      expect(present).toBe(scenario !== "clean");
      expect(existsSync(recovery)).toBe(scenario !== "clean");
      expect(probeCount).toBe(scenario === "keep-data" ? 0 : 1);
      const runningApps = result.steps.find((step) => step.id === "running-apps");
      if (scenario === "dry-run") expect(runningApps?.detail).toContain("1 built image");
      else if (scenario !== "clean" && scenario !== "keep-data")
        expect(runningApps).toMatchObject({ outcome: "failed" });
      else expect(result.failed).toBe(false);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  },
);
