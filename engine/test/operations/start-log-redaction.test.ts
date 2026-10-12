import { afterEach, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { StartFailureLogRedactor } from "@lando/container-runtime/redact";
import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  Downloader,
  LogFileHelperAssets,
  ManagedFileService,
  PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { startApp } from "../../src/operations/start.ts";
import { makeRuntimeProviderRegistry } from "../../src/providers/registry.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

const registryLayerFor = (harness: ReturnType<typeof makeHarness>) => {
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/log-redaction-provider",
    version: "1.0.0",
    api: 4,
    contributes: { providers: [plan.provider] },
  });
  const module: LandoPluginModule = {
    name: manifest.name,
    manifest,
    runtimeProviders: new Map([
      [
        plan.provider,
        {
          id: plan.provider,
          appliedPlans: () => Effect.die("not used"),
          make: () => harness.runtimeProviderRegistry.select(),
        },
      ],
    ]),
  };
  const unsupported = (name: string) =>
    Effect.fail(new PluginLoadError({ message: "unused", pluginName: name }));
  const dependencies = Layer.mergeAll(
    harness.layer,
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([manifest]),
        load: unsupported,
        loadServiceType: unsupported,
        loadServiceFeature: unsupported,
        loadAppFeature: unsupported,
      }),
    ),
    Layer.succeed(Downloader, Effect.runSync(makeTestDownloader()).service),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)))),
    ),
    Layer.succeed(LogFileHelperAssets, LogFileHelperAssets.of({ payloads: Effect.succeed({}) })),
    Layer.succeed(ManagedFileService, Effect.runSync(makeTestManagedFileStore()).service),
    Layer.succeed(AppPlanSanitizer, AppPlanSanitizer.of({ sanitizeForPersistence: (value) => value })),
  );
  return makeRuntimeProviderRegistry([module], {
    enforce: async () => undefined,
    verify: async () => undefined,
  }).pipe(Layer.provide(dependencies));
};

test("start supplies a canonical redactor with registered plan secrets to provider apply", async () => {
  const password = "opaque-start-log-password";
  const plannedApp = {
    ...plan,
    services: { [web.name]: { ...web, environment: { DATABASE_PASSWORD: password } } },
  };
  let captured: string | undefined;
  const harness = makeHarness({
    plannedApp,
    applyEffect: Effect.gen(function* () {
      const redactor = yield* StartFailureLogRedactor;
      captured = redactor.redactString(`failed with ${password}`);
      return { changed: true };
    }),
  });

  await Effect.runPromise(
    startApp(
      {},
      {
        plan: plannedApp,
        root: plannedApp.root,
        app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
      },
    ).pipe(Effect.provide(registryLayerFor(harness)), Effect.provide(harness.layer)),
  );

  expect(captured).toBe("failed with [redacted]");
});

test("selected provider apply redacts new plan and resolved environment secrets without start", async () => {
  const password = "opaque-restart-log-password";
  const resolved = "opaque-resolved-log-password";
  let captured: string | undefined;
  const harness = makeHarness({
    applyEffect: Effect.gen(function* () {
      const redactor = yield* StartFailureLogRedactor;
      captured = redactor.redactString(`failed with ${password} and ${resolved}`);
      return { changed: true };
    }),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(plan);
      return yield* Effect.scoped(
        provider.apply(
          {
            ...plan,
            services: { [web.name]: { ...web, environment: { DATABASE_PASSWORD: password } } },
          },
          { reconcile: false, serviceEnvironment: { [web.name]: { DATABASE_PASSWORD: resolved } } },
        ),
      );
    }).pipe(Effect.provide(registryLayerFor(harness))),
  );

  expect(captured).toBe("failed with [redacted] and [redacted]");
});
