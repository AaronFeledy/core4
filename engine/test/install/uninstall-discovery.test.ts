import { expect, test } from "bun:test";
import { preflightDataRootPurge } from "@lando/container-runtime/data-root-purge";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import type { LandoPluginModule, ProviderPurgeHook } from "@lando/sdk/plugins";
import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { makePrepareUninstallCleanup, providerPurgeHooks } from "../../src/install/uninstall-discovery.ts";

const missingRuntime = async () => {
  throw Object.assign(new Error("not installed"), { code: "ENOENT" });
};

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
    "docker: no engine answered at /test/unreachable.sock, so there was nothing to clean there (HTTP 503).",
  );
});
