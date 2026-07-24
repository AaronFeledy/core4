import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";

import { buildKeyForService } from "../../../core/src/services/build-key.ts";
import { PHP_COMMON_EXTENSIONS, php82ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const appId = AppId.make("php-prerequisites-smoke");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("lando");
const appRoot = AbsolutePath.make("/tmp/php-prerequisites-smoke");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-23T00:00:00Z"),
  source: "php-prerequisites.integration.test",
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

describe("stock PHP prerequisites — live provider", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "builds the stock image with verified Composer, unzip, and common extensions",
    async () => {
      // Given
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: makePodmanApiClient(socket.socketPath) })),
        ),
      );
      const configuredService = Schema.decodeUnknownSync(LandofileShape)({
        name: String(appId),
        services: { [serviceName]: { type: "php:8.2" } },
      }).services?.[serviceName];
      expect(configuredService).toBeDefined();
      if (configuredService === undefined) return;
      const service = await composeServicePlan({
        serviceType: php82ServiceType,
        service: configuredService,
        appRoot,
        appName: String(appId),
        serviceName: String(serviceName),
        metadata,
        featureOverrides: new Map([[phpServiceFeature.id, phpServiceFeature]]),
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
      const buildKey = await Effect.runPromise(buildKeyForService(provider, service));

      // When
      const artifact = await Effect.runPromise(
        Effect.scoped(provider.buildArtifact({ app: appId, service: serviceName, plan, buildKey })),
      );
      try {
        const runtimeRoot = dirname(dirname(socket.socketPath));
        const composer = await runBuiltImage(runtimeRoot, artifact.ref, ["composer", "--version"]);
        const unzip = await runBuiltImage(runtimeRoot, artifact.ref, ["unzip", "-v"]);
        const modules = await runBuiltImage(runtimeRoot, artifact.ref, ["php", "-m"]);

        // Then
        expect(composer.exitCode, composer.stderr).toBe(0);
        expect(composer.stdout).toContain("Composer version 2.10.2");
        expect(unzip.exitCode, unzip.stderr).toBe(0);
        expect(unzip.stdout).toContain("UnZip 6.00");
        expect(modules.exitCode, modules.stderr).toBe(0);
        const loaded = new Set(
          modules.stdout
            .split("\n")
            .map((module) => module.trim().toLowerCase())
            .map((module) => (module === "zend opcache" ? "opcache" : module)),
        );
        for (const extension of PHP_COMMON_EXTENSIONS) expect(loaded.has(extension)).toBe(true);
      } finally {
        await Effect.runPromise(provider.removeArtifact(artifact));
      }
    },
    600_000,
  );
});
