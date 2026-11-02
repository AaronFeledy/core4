import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { FileSyncEngine, type FileSyncEngineShape } from "@lando/sdk/services";
import { Layer, Schema } from "effect";

export const lifecycleFileSyncPlugin = (engine: FileSyncEngineShape) => {
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@test/lifecycle-sync",
    version: "1.0.0",
    api: 4,
    contributes: {
      fileSyncEngines: [
        {
          id: engine.id,
          supports: { platform: ["linux", "darwin", "win32"] },
          capabilities: engine.capabilities,
        },
      ],
    },
  });
  const entry = definePlugin({
    name: manifest.name,
    manifest,
    fileSyncEngines: new Map([[engine.id, { make: () => Layer.succeed(FileSyncEngine, engine) }]]),
  });
  return { manifest, entry };
};
