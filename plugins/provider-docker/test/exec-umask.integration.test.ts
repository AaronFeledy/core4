import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { parseProcSelfStatusUmask } from "@lando/container-runtime/podman/exec-umask";
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
const fixtureId = `exec-umask-mode-${crypto.randomUUID()}`;
const appId = AppId.make(fixtureId);
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
  valueModel: 1,
  id: appId,
  name: "Exec Umask Mode",
  slug: fixtureId,
  root: AbsolutePath.make(join(tmpdir(), fixtureId)),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
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
        const target = { app: appId, service: serviceName };
        const raw = await Effect.runPromise(
          provider.exec(target, {
            command: ["cat", "/proc/self/status"],
            raw: true,
          }),
        );
        expect(raw.exitCode).toBe(0);
        const inherited = parseProcSelfStatusUmask(raw.stdout);
        expect(inherited).toBeDefined();
        const effective = await Effect.runPromise(
          provider.exec(target, {
            command: ["cat", "/proc/self/status"],
          }),
        );
        expect(effective.exitCode).toBe(0);
        expect(parseProcSelfStatusUmask(effective.stdout)).toBe(inherited === "0000" ? "0022" : inherited);
        const authored = await Effect.runPromise(
          provider.exec(target, {
            command: ["/bin/sh", "-c", "umask 0077; exec cat /proc/self/status"],
          }),
        );
        expect(authored.exitCode).toBe(0);
        expect(parseProcSelfStatusUmask(authored.stdout)).toBe("0077");
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
