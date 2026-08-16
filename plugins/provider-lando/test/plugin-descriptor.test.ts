import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/core/paths";
import { makeTestDownloader, makeTestStateStore } from "@lando/core/testing";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { type LandoPluginContext, definePlugin } from "@lando/sdk/plugins";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { AppPlanSanitizer, Downloader, LogFileHelperAssets, PathsService } from "@lando/sdk/services";

import { manifest, plugin } from "../src/index.ts";

const contributionId = (entry: string | { readonly id: string }): string =>
  typeof entry === "string" ? entry : entry.id;

describe("provider-lando plugin descriptor", () => {
  test("declares the manifest provider factory when loaded", () => {
    // Given: provider-lando's decoded plugin manifest.
    const expectedProviderIds = (manifest.contributes?.providers ?? []).map(contributionId);

    // When: the exported descriptor is inspected by the plugin loader.
    const runtimeProviderIds = Array.from(plugin.runtimeProviders?.keys() ?? [], String);
    const runtimeProvider = plugin.runtimeProviders?.get(
      ProviderId.make(expectedProviderIds[0] ?? "missing"),
    );

    // Then: its identity and runtime-provider contribution exactly match the manifest.
    expect(plugin.name).toBe(manifest.name);
    expect(runtimeProviderIds).toEqual(expectedProviderIds);
    expect(typeof runtimeProvider?.make).toBe("function");
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("contributes managed runtime host teardown", () => {
    // Given: provider-lando's exported plugin descriptor.

    // When: host maintenance contributions are inspected.
    const maintainerIds = plugin.hostMaintainers?.map((maintainer) => maintainer.id);

    // Then: the managed runtime service has one stable teardown contribution.
    expect(maintainerIds).toEqual(["lando-runtime-service"]);
  });

  test("contributes the WSL root mount propagation doctor check", () => {
    // Given: provider-lando's exported plugin descriptor.

    // When: doctor contributions are inspected.
    const doctorCheckIds = plugin.doctorChecks?.map((check) => check.id);

    // Then: the WSL propagation check is wired into the plugin.
    expect(doctorCheckIds).toEqual(["wsl-root-mount-propagation"]);
  });

  test("builds the existing provider availability and setup surface when services are provided", async () => {
    // Given: the SDK services required by a runtime-provider factory and plugin-scoped state.
    const paths = makeLandoPaths({ userDataRoot: "/tmp/provider-lando-plugin-descriptor" });
    const downloader = Effect.runSync(makeTestDownloader()).service;
    const stateStore = makeTestStateStore().service;
    const ctx: LandoPluginContext = {
      id: manifest.name,
      managedFiles: { pluginId: manifest.name },
      stateStore: makePluginStateStore(
        stateStore,
        AbsolutePath.make("/tmp/provider-lando-plugin-descriptor/state"),
      ),
      events: { publishRender: () => Effect.void },
    };
    const services = Layer.mergeAll(
      Layer.succeed(PathsService, paths),
      Layer.succeed(Downloader, downloader),
      Layer.succeed(LogFileHelperAssets, { payloads: Effect.succeed({}) }),
      Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence: (plan) => plan }),
    );
    const runtimeProvider = plugin.runtimeProviders?.values().next().value;
    if (runtimeProvider === undefined) throw new Error("expected provider-lando runtime contribution");

    // When: the descriptor factory is evaluated with those services.
    const provider = await Effect.runPromise(runtimeProvider.make(ctx).pipe(Effect.provide(services)));
    const available = await Effect.runPromise(provider.isAvailable);

    // Then: it exposes the same available provider and setup entry points as makeRuntimeProvider.
    expect(provider.id).toBe("lando");
    expect(available).toBe(true);
    expect(typeof provider.planSetup).toBe("function");
    expect(typeof provider.setup).toBe("function");
  });
});
