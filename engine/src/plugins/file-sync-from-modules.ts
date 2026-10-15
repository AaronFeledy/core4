import { Effect, Layer, Result, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSyncEngine, ManagedFileService, PathsService, StateStore } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { bundledPluginModules } from "../composition.ts";
import { makeLandoPluginContext } from "./context.ts";
import { makePluginCapabilityIndex } from "./module-set.ts";

const BUNDLED_FILE_SYNC_ENGINE_ID = "mutagen";

const mismatch = (provided: ReadonlyArray<string>) =>
  new PluginDescriptorMismatchError({
    pluginName: "@lando/file-sync-mutagen",
    kind: "fileSyncEngines",
    declared: [BUNDLED_FILE_SYNC_ENGINE_ID],
    provided,
    message: `Bundled file-sync engine ${BUNDLED_FILE_SYNC_ENGINE_ID} is unavailable.`,
    remediation: `Add ${BUNDLED_FILE_SYNC_ENGINE_ID} to the bundled plugin descriptor map.`,
  });

export const layerWith = (modules: ReadonlyArray<LandoPluginModule>) =>
  Result.match(makePluginCapabilityIndex(modules), {
    onFailure: (error) => Layer.effect(FileSyncEngine, Effect.fail(error)),
    onSuccess: (index) => {
      const contribution = index.fileSyncEngines.get(BUNDLED_FILE_SYNC_ENGINE_ID);
      const module = modules.find(
        (candidate) => candidate.fileSyncEngines?.get(BUNDLED_FILE_SYNC_ENGINE_ID) === contribution,
      );
      if (contribution === undefined || module === undefined)
        return Layer.effect(
          FileSyncEngine,
          Effect.fail(mismatch([...index.fileSyncEngines.keys()].map(String))),
        );

      return Layer.unwrap(
        Effect.gen(function* () {
          const paths = yield* PathsService;
          const managedFileService = yield* ManagedFileService;
          const stateStore = yield* StateStore;
          const privateFileAccess = yield* PrivateFileAccessService;
          const httpClient = yield* HttpClient.HttpClient;
          const pluginStateRoot = yield* Schema.decodeUnknownEffect(AbsolutePath)(
            paths.pluginStateDir(module.name),
          ).pipe(Effect.mapError(() => mismatch([BUNDLED_FILE_SYNC_ENGINE_ID])));
          return contribution.make(
            makeLandoPluginContext({
              id: module.name,
              managedFileService,
              stateStore,
              pluginStateRoot,
              privateFileAccess,
              httpClient,
            }),
          );
        }),
      );
    },
  });

export const layer = Layer.suspend(() => layerWith(bundledPluginModules()));
