import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliedPlanPath, makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { preflightDataRootPurge, preflightRecordedPurge } from "@lando/container-runtime/data-root-purge";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { dockerEngineIdentity } from "@lando/container-runtime/engine-identity";
import { makeLandoPaths } from "@lando/paths";
import type { LandoPluginModule, ProviderPurgeHook } from "@lando/sdk/plugins";
import { AppId, ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { makePrepareUninstallCleanup, providerPurgeHooks } from "../../src/install/uninstall-discovery.ts";

const missingRuntime = async () => {
  throw Object.assign(new Error("not installed"), { code: "ENOENT" });
};

test.each([200, 503])(
  "purge reports unreadable placement without requiring a repair (ping %d)",
  async (status) => {
    const dataRoot = await mkdtemp(join(tmpdir(), "purge-unreadable-"));
    try {
      const pluginId = "@lando/provider-docker";
      const root = makeLandoPaths({ userDataRoot: dataRoot }).pluginStateDir(pluginId);
      const path = appliedPlanPath(root, AppId.make("web"));
      await Bun.write(path, "not a plan");
      const store = makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });
      const purge: ProviderPurgeHook = (input) =>
        preflightRecordedPurge(
          { providerId: "docker", remediation: "Retry", env: {} },
          { ...input, pluginId },
          store.listAppliedPlans,
          {
            endpoint: "/fixture.sock",
            identify: dockerEngineIdentity,
            api: {
              info: Effect.succeed({ ID: "current" }),
              request: ({ method, path }) =>
                method !== "GET"
                  ? Effect.die("No ownership evidence for deletion")
                  : Effect.succeed({
                      status: path === "/_ping" ? status : 200,
                      body: path.startsWith("/volumes?") ? '{"Volumes":null}' : "[]",
                    }),
            },
          },
        );
      const prepared = await makePrepareUninstallCleanup(
        [{ providerId: "docker", purge }],
        missingRuntime,
        "linux",
      )(dataRoot, join(dataRoot, "cache"));
      expect(prepared.detail).toContain(path);
      expect(await prepared.cleanup()).toContain(path);
      expect(await Bun.file(path).text()).toBe("not a plan");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
);

test("descriptor-only discovery reports this root's app without constructing a runtime provider", async () => {
  const providerId = ProviderId.make("podman");
  const api: EngineHttpApi = {
    request: ({ method, path }) =>
      Effect.sync(() => {
        if (method !== "GET") throw new Error("Discovery issued a mutation");
        if (path.startsWith("/containers/json"))
          return { status: 200, body: '[{"Id":"here"},{"Id":"peer"}]' };
        if (path.startsWith("/containers/"))
          return {
            status: 200,
            body: JSON.stringify({
              Id: path.split("/")[2],
              Config: {
                Labels: {
                  "dev.lando.app": "app",
                  "dev.lando.app-root": "/project",
                  "dev.lando.service": "web",
                  "dev.lando.data-root": path.includes("/here/") ? "/uninstall-test-data" : "/peer",
                },
              },
            }),
          };
        return { status: 200, body: path.startsWith("/volumes?") ? '{"Volumes":null}' : "[]" };
      }),
  };
  const purge: ProviderPurgeHook = (input) =>
    preflightDataRootPurge(
      api,
      { providerId, remediation: "Retry", env: {} },
      { ...input, endpoint: "/test/engine.sock", pluginId: "@lando/provider-podman" },
    );
  const descriptor: Pick<LandoPluginModule, "runtimeProviders"> = {
    runtimeProviders: new Map([
      [
        providerId,
        {
          id: providerId,
          purge,
          appliedPlans: () => Effect.die("no applied plan bootstrap"),
          appliedStateInventory: () => Effect.die("no applied state inventory read"),
          readAppliedPlanStrict: () => Effect.die("no applied plan read"),
          make: () => Effect.die("no provider bootstrap"),
        },
      ],
    ]),
  };
  const prepare = makePrepareUninstallCleanup(providerPurgeHooks([descriptor]), missingRuntime, "linux");
  expect((await prepare("/uninstall-test-data", "/uninstall-test-cache")).apps).toEqual([
    { appId: "app", appName: "app", providerId, appRoot: "/project", services: [] },
  ]);
});

test("skips an unreachable endpoint and still completes cleanup", async () => {
  const purge: ProviderPurgeHook = (input) =>
    preflightDataRootPurge(
      {
        request: ({ path }) => {
          if (path !== "/_ping") return Effect.die("Unreachable endpoint was queried");
          return Effect.succeed({ status: 503, body: "" });
        },
      },
      { providerId: "docker", remediation: "Retry", env: {} },
      { ...input, endpoint: "/test/unreachable.sock", pluginId: "@lando/provider-docker" },
    );
  const prepared = await makePrepareUninstallCleanup([{ providerId: "docker", purge }], missingRuntime)(
    "/uninstall-test-data",
    "/uninstall-test-cache",
  );
  expect(prepared.apps).toEqual([]);
  expect(await prepared.cleanup()).toContain(
    "docker: no engine answered at /test/unreachable.sock; cleanup was skipped (HTTP 503).",
  );
});
