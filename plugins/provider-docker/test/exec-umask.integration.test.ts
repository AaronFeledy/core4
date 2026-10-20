import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeDockerApiClient, layer as providerLayer } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

import { ownerOnlyFileAccess } from "./private-file-access.ts";

const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
const appId = AppId.make("exec-umask-mode");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
  source: "provider-docker/exec-umask.integration.test.ts",
  runtime: 4 as const,
};

const makeProviderLayer = () =>
  providerLayer({
    platform: "linux",
    dockerApi: makeDockerApiClient(dockerHost ?? ""),
    appliedPlanState: makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make(join(tmpdir(), `docker-exec-umask-${crypto.randomUUID()}`)),
      ownerOnlyFileAccess,
    ),
  });

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "alpine:3.20" },
  command: ["sleep", "3600"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Exec Umask Mode",
  slug: "exec-umask-mode",
  root: AbsolutePath.make("/tmp/lando-exec-umask-mode"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("docker exec umask mode", () => {
  test.skipIf(dockerHost === undefined)(
    "lando exec creates 0644 files",
    async () => {
      const provider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(makeProviderLayer())));
      await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
      try {
        const created = await Effect.runPromise(
          provider.exec(
            { app: appId, service: serviceName },
            { command: ["touch", "/tmp/lando-exec-umask"] },
          ),
        );
        expect(created.exitCode).toBe(0);
        const mode = await Effect.runPromise(
          provider.exec(
            { app: appId, service: serviceName },
            { command: ["stat", "-c", "%a", "/tmp/lando-exec-umask"] },
          ),
        );
        expect(mode.exitCode).toBe(0);
        expect(mode.stdout.trim()).toBe("644");
      } finally {
        await Effect.runPromise(provider.destroy({ app: appId }, { volumes: true }));
      }
    },
    60_000,
  );
});
