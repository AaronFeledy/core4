import { describe, expect, test } from "bun:test";

import { buildKeyForService } from "@lando/engine/services/build-key";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient, layer as makeProviderLayer } from "@lando/provider-lando";
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

import { PHP_COMMON_EXTENSIONS, php82ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { runBuiltImage } from "./support/run-built-image.ts";

const appId = AppId.make("php-prerequisites-smoke");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("lando");
const appRoot = AbsolutePath.make("/tmp/php-prerequisites-smoke");
const metadata = {
  resolvedAt: "2026-07-23T00:00:00Z",
  source: "php-prerequisites.integration.test",
  runtime: 4 as const,
};
const planMetadata = {
  ...metadata,
  resolvedAt: DateTime.makeUnsafe(metadata.resolvedAt),
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
          Effect.provide(
            makeProviderLayer({
              platform: "linux",
              podmanApi: makePodmanApiClient(socket.socketPath),
              sanitizeAppliedPlan: stripHostProxyRunLando,
            }),
          ),
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
        stores: [],
        fileSync: [],
        metadata: planMetadata,
        extensions: {},
      };
      const buildKey = await Effect.runPromise(buildKeyForService(provider, service));

      // When
      const artifact = await Effect.runPromise(
        Effect.scoped(
          provider.buildArtifact({
            labels: { "dev.lando.test": crypto.randomUUID() },
            app: appId,
            service: serviceName,
            plan,
            buildKey,
            ref: `lando-build-test-${crypto.randomUUID()}-php`,
          }),
        ),
      );
      try {
        const composer = await runBuiltImage(socket.socketPath, artifact.ref, ["composer", "--version"]);
        const unzip = await runBuiltImage(socket.socketPath, artifact.ref, ["unzip", "-v"]);
        const modules = await runBuiltImage(socket.socketPath, artifact.ref, ["php", "-m"]);

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
        expect(
          (await Effect.runPromise(provider.removeArtifact({ ...artifact, pruneParents: true }))).kind,
        ).toBe("removed");
      }
    },
    600_000,
  );
});
