import { FileSyncEngine, type FileSyncEngineShape } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { FileSyncResolver } from "../src/plugins/file-sync-resolver.ts";

export const fileSyncEngineLayer = (engine: FileSyncEngineShape) =>
  Layer.merge(
    Layer.succeed(FileSyncEngine, engine),
    FileSyncResolver.layerWithEngine(engine, { platform: ["linux", "darwin", "win32"] }),
  );

export const provideFileSyncEngine = (engine: FileSyncEngineShape) =>
  Effect.provide(fileSyncEngineLayer(engine));
