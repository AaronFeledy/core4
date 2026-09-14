import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { buildKeyForService, resolveLiveProviderSocket, stripHostProxyRunLando } from "@lando/core/testing";
import { makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider, type ServiceFeatureDefinition, type ServiceType } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";

import { NODE_FEATURE_ID, node22ServiceType, nodeServiceFeature } from "../src/services/node.ts";
import { PHP_FEATURE_ID, php83ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-13T00:00:00Z"),
  source: "package-installs.integration.test",
  runtime: 4 as const,
};

const runBuiltImage = async (
  runtimeRoot: string,
  image: string,
  command: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn(
    [
      join(runtimeRoot, "bin", "podman"),
      "--root",
      join(runtimeRoot, "storage"),
      "--runroot",
      join(runtimeRoot, "run"),
      "--config",
      join(runtimeRoot, "config"),
      "run",
      "--rm",
      image,
      ...command,
    ],
    {
      env: { ...process.env, CONTAINERS_CONF: join(runtimeRoot, "config", "containers.conf") },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const decodeService = (appId: AppId, raw: Record<string, unknown>): ServiceConfig => {
  const service = Schema.decodeUnknownSync(LandofileShape)({
    name: String(appId),
    services: { [serviceName]: raw },
  }).services?.[serviceName];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const planFor = async (
  appId: AppId,
  serviceType: ServiceType,
  featureId: string,
  feature: ServiceFeatureDefinition,
  raw: Record<string, unknown>,
): Promise<readonly [AppPlan, ServicePlan]> => {
  const appRoot = AbsolutePath.make(`/tmp/${String(appId)}`);
  const service = await composeServicePlan({
    serviceType,
    service: decodeService(appId, raw),
    appRoot,
    appName: String(appId),
    serviceName: String(serviceName),
    metadata: { ...metadata, resolvedAt: DateTime.formatIso(metadata.resolvedAt) },
    featureOverrides: new Map([[featureId, feature]]),
  });
  const plan: AppPlan = {
    id: appId,
    name: String(appId),
    slug: String(appId),
    root: appRoot,
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  return [plan, service] as const;
};

const liveProvider = async (socketPath: string) =>
  Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          platform: "linux",
          podmanApi: makePodmanApiClient(socketPath),
          sanitizeAppliedPlan: stripHostProxyRunLando,
        }),
      ),
    ),
  );

describe("catalog package installs — live provider", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "installs global npm packages into the stock node image",
    async () => {
      // Given a node service authoring globals,
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const provider = await liveProvider(socket.socketPath);
      const [plan, service] = await planFor(
        AppId.make("node-globals-smoke"),
        node22ServiceType,
        NODE_FEATURE_ID,
        nodeServiceFeature,
        { type: "node:22", globals: { cowsay: "1.6.0" } },
      );
      const buildKey = await Effect.runPromise(buildKeyForService(provider, service));

      // When the artifact is built,
      const artifact = await Effect.runPromise(
        Effect.scoped(provider.buildArtifact({ app: plan.id, service: serviceName, plan, buildKey })),
      );
      try {
        const runtimeRoot = dirname(dirname(socket.socketPath));
        const listed = await runBuiltImage(runtimeRoot, artifact.ref, ["npm", "ls", "-g", "--depth=0"]);
        const invoked = await runBuiltImage(runtimeRoot, artifact.ref, ["cowsay", "moo"]);

        // Then the package is installed and callable by name.
        expect(listed.exitCode, listed.stderr).toBe(0);
        expect(listed.stdout).toContain("cowsay@1.6.0");
        expect(invoked.exitCode, invoked.stderr).toBe(0);
        expect(invoked.stdout).toContain("moo");
      } finally {
        await Effect.runPromise(provider.removeArtifact(artifact));
      }
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "installs global Composer packages into the stock PHP image",
    async () => {
      // Given a PHP service authoring the composer object form,
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const provider = await liveProvider(socket.socketPath);
      const [plan, service] = await planFor(
        AppId.make("composer-packages-smoke"),
        php83ServiceType,
        PHP_FEATURE_ID,
        phpServiceFeature,
        {
          type: "php:8.3",
          composer: { version: "2", packages: { "squizlabs/php_codesniffer": "^3.10" } },
        },
      );
      const buildKey = await Effect.runPromise(buildKeyForService(provider, service));

      // When the artifact is built,
      const artifact = await Effect.runPromise(
        Effect.scoped(provider.buildArtifact({ app: plan.id, service: serviceName, plan, buildKey })),
      );
      try {
        const runtimeRoot = dirname(dirname(socket.socketPath));
        const version = await runBuiltImage(runtimeRoot, artifact.ref, ["phpcs", "--version"]);
        const shown = await runBuiltImage(runtimeRoot, artifact.ref, [
          "sh",
          "-c",
          "COMPOSER_HOME=/usr/local/composer COMPOSER_ALLOW_SUPERUSER=1 composer global show",
        ]);

        // Then the tool is on PATH and recorded in the global Composer home.
        expect(version.exitCode, version.stderr).toBe(0);
        expect(version.stdout).toContain("PHP_CodeSniffer");
        expect(shown.exitCode, shown.stderr).toBe(0);
        expect(shown.stdout).toContain("squizlabs/php_codesniffer");
      } finally {
        await Effect.runPromise(provider.removeArtifact(artifact));
      }
    },
    600_000,
  );
});
