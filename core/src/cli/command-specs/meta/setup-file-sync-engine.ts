import type { Layer } from "effect";

import type { Downloader, FileSyncEngine, PathsService } from "@lando/sdk/services";

import { BundledFileSyncEngineLive } from "@lando/engine/plugins/file-sync-from-modules";

/**
 * The generic plugin descriptor contract erases Layer requirements to unknown.
 * The bundled descriptor index validates this concrete engine before exposing it;
 * its construction requirements are the provider-bootstrap paths and downloader.
 */
export const SetupFileSyncEngineLive = BundledFileSyncEngineLive as Layer.Layer<
  FileSyncEngine,
  unknown,
  PathsService | Downloader
>;
