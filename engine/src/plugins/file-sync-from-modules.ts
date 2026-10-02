import { Effect, Result, Layer } from "effect";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { FileSyncEngine } from "@lando/sdk/services";

import { bundledPluginModules } from "../composition.ts";
import { makePluginCapabilityIndex } from "./module-set.ts";

const BUNDLED_FILE_SYNC_ENGINE_ID = "mutagen";

export const makeBundledFileSyncEngineLive = (modules: ReadonlyArray<LandoPluginModule>) =>
  Result.match(makePluginCapabilityIndex(modules), {
    onFailure: (error) => Layer.effect(FileSyncEngine, Effect.fail(error)),
    onSuccess: (index) =>
      index.fileSyncEngines.get(BUNDLED_FILE_SYNC_ENGINE_ID) ??
      Layer.effect(
        FileSyncEngine,
        Effect.fail(
          new PluginDescriptorMismatchError({
            pluginName: "@lando/file-sync-mutagen",
            kind: "fileSyncEngines",
            declared: [BUNDLED_FILE_SYNC_ENGINE_ID],
            provided: [...index.fileSyncEngines.keys()].map(String),
            message: `Bundled file-sync engine ${BUNDLED_FILE_SYNC_ENGINE_ID} is unavailable.`,
            remediation: `Add ${BUNDLED_FILE_SYNC_ENGINE_ID} to the bundled plugin descriptor map.`,
          }),
        ),
      ),
  });

export const BundledFileSyncEngineLive = Layer.suspend(() =>
  makeBundledFileSyncEngineLive(bundledPluginModules()),
);
