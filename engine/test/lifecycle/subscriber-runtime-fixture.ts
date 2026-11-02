import { Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { GlobalConfig } from "@lando/sdk/schema";
import {
  CommandRegistry,
  ConfigService,
  LandofileService,
  Logger,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  StateStore,
} from "@lando/sdk/services";
import { makeTestStateStore } from "@lando/state-store/testing";

import { layer as subscriberLayer } from "../../src/lifecycle/subscribers.ts";
import { layerWith as eventLayer } from "../../src/services/event-service.ts";
import { stubHttpClient } from "../plugins/stub-http-client.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const forbidden = (operation: string) => Effect.die(new Error(`Unexpected observer IO: ${operation}`));

/** Real event dispatch with in-memory plugin services; app acquisition is forbidden. */
export const subscriberRuntime = (modules: ReadonlyArray<LandoPluginModule>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const managedFiles = yield* makeTestManagedFileStore();
      const config = Schema.decodeUnknownSync(GlobalConfig)({});
      const dependencies = Layer.mergeAll(
        eventLayer(0),
        RedactionService.layer,
        Layer.succeed(PluginRegistry, {
          list: Effect.succeed(modules.map((module) => module.manifest)),
          load: () => forbidden("plugin load"),
          loadServiceType: () => forbidden("service type load"),
          loadServiceFeature: () => forbidden("service feature load"),
          loadAppFeature: () => forbidden("app feature load"),
        }),
        Layer.succeed(CommandRegistry, { list: forbidden("CommandRegistry.list") }),
        Layer.succeed(LandofileService, { discover: forbidden("LandofileService.discover") }),
        Layer.succeed(ConfigService, {
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
        Layer.succeed(Logger, {
          debug: () => forbidden("subscriber failure"),
          info: () => Effect.void,
          warn: () => forbidden("subscriber failure"),
          error: () => forbidden("subscriber failure"),
        }),
        Layer.succeed(ManagedFileService, managedFiles.service),
        Layer.succeed(StateStore, makeTestStateStore().service),
        Layer.succeed(PathsService, makeLandoPaths()),
        Layer.succeed(HttpClient.HttpClient, stubHttpClient()),
      );
      return subscriberLayer(ownerOnlyFileAccess, modules, ["meta:version", "app:start"]).pipe(
        Layer.provideMerge(dependencies),
      );
    }),
  );
