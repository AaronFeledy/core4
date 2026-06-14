/**
 * `@lando/file-sync-mutagen` bundles the Mutagen-backed `FileSyncEngine` for
 * slow bind-mount providers (`provider-lando` on macOS, `provider-docker` on
 * macOS / Windows, `provider-podman` on macOS / Windows).
 *
 * It exports the engine, Live Layer, deterministic session naming, and the
 * `MutagenClient` seam used by the in-memory fake.
 *
 * Capability matrix is fixed:
 *   `modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"]`,
 *   `remoteAgentDeployment: "auto"`, `exclusionPatterns: true`,
 *   `conflictReporting: true`, `progressReporting: true`.
 */

import path from "node:path";

import { Effect, Layer, Schema, type Scope, type Stream } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import {
  type FileSyncEngineCapabilities as FileSyncEngineCapabilitiesType,
  type FileSyncEventChunk,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  type FileSyncSessionRef,
  type FileSyncSessionSpec,
  type FileSyncSetupOptions,
  PluginManifest,
} from "@lando/sdk/schema";
import { FileSyncEngine, type FileSyncEngineShape, type FileSyncError } from "@lando/sdk/services";

import { type MutagenDownloader, makeMutagenDownloader } from "./download.ts";
import { type MutagenClient, makeUnavailableMutagenClient, toFileSyncSessionInfo } from "./mutagen-client.ts";
import { mutagenSessionName, mutagenSessionRef } from "./session-name.ts";

export const PLUGIN_NAME = "@lando/file-sync-mutagen" as const;
export const ENGINE_ID = "mutagen" as const;
export const ENGINE_DISPLAY_NAME = "Mutagen" as const;

/**
 * Capability matrix for the bundled Mutagen engine. This is a fixed
 * declaration; it does not depend on host platform or daemon state.
 */
export const mutagenCapabilities: FileSyncEngineCapabilitiesType = {
  modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"],
  remoteAgentDeployment: "auto",
  exclusionPatterns: true,
  conflictReporting: true,
  progressReporting: true,
};

const usesWin32Path = (value: string): boolean => /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");

const sourceIsInsideAppRoot = (spec: FileSyncSessionSpec): boolean => {
  const pathApi = usesWin32Path(spec.app.root) || usesWin32Path(spec.source) ? path.win32 : path.posix;
  const root = pathApi.normalize(spec.app.root);
  const source = pathApi.normalize(spec.source);
  const relative = pathApi.relative(root, source);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
};

const filterMatches = (info: FileSyncSessionInfo, filter: FileSyncSessionFilter): boolean => {
  if (
    filter.app !== undefined &&
    (info.app.kind !== filter.app.kind || info.app.id !== filter.app.id || info.app.root !== filter.app.root)
  ) {
    return false;
  }
  if (filter.service !== undefined && info.service !== filter.service) return false;
  if (filter.mountKey !== undefined && info.mountKey !== filter.mountKey) return false;
  return true;
};

export interface MakeFileSyncEngineOptions {
  /** Override the underlying Mutagen transport. Tests can pass
   *  `makeFakeMutagenClient()`; the default client fails closed until the
   *  host-CLI-backed client is available. */
  readonly client?: MutagenClient;
  /**
   * When provided, `setup()` downloads the Mutagen host CLI and agent
   * binaries to `<userDataRoot>/bin/` from the pinned manifest.
   * Omit when using a fake client in tests that do not exercise the download path.
   */
  readonly userDataRoot?: string;
  /**
   * Override the binary downloader used by `setup()`. Defaults to
   * `makeMutagenDownloader()`, and tests can inject a fake downloader.
   */
  readonly downloader?: MutagenDownloader;
}

/**
 * Build the `FileSyncEngine` service. With no options it uses
 * `makeUnavailableMutagenClient()`, which fails closed with the standard
 * "run `lando setup`" remediation. Tests can pass a fake client (see
 * `makeFakeMutagenClient`) for deterministic in-memory coverage.
 */
export const makeFileSyncEngine = (options: MakeFileSyncEngineOptions = {}): FileSyncEngineShape => {
  const client = options.client ?? makeUnavailableMutagenClient();

  const createSession = (
    spec: FileSyncSessionSpec,
  ): Effect.Effect<FileSyncSessionRef, FileSyncError, Scope.Scope> =>
    Effect.gen(function* () {
      if (!sourceIsInsideAppRoot(spec)) {
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId: ENGINE_ID,
            message: `File-sync source "${spec.source}" must resolve inside the app root "${spec.app.root}".`,
            sessionSpec: spec,
            remediation:
              "Use a source path inside the app root (the project directory containing the Landofile).",
          }),
        );
      }

      const name = mutagenSessionName(spec);
      yield* client.create({ name, spec });

      yield* Effect.addFinalizer(() => client.terminate(name).pipe(Effect.catchAll(() => Effect.void)));

      return mutagenSessionRef(spec);
    });

  return {
    id: ENGINE_ID,
    displayName: ENGINE_DISPLAY_NAME,
    capabilities: mutagenCapabilities,

    isAvailable: client.version.pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
    setup: (setupOptions: FileSyncSetupOptions) => {
      const { userDataRoot } = options;
      if (userDataRoot === undefined) return Effect.void;
      const downloader = options.downloader ?? makeMutagenDownloader();
      return downloader.setup({
        userDataRoot,
        force: setupOptions.force,
      }) as Effect.Effect<void, FileSyncError, never>;
    },

    createSession,

    pauseSession: (ref) => client.pause(ref as unknown as string),
    resumeSession: (ref) =>
      client.resume(ref as unknown as string) as Effect.Effect<void, FileSyncError, never>,
    terminateSession: (ref) => client.terminate(ref as unknown as string),

    listSessions: (filter) =>
      client.list.pipe(
        Effect.map((records) =>
          records.map(toFileSyncSessionInfo).filter((info) => filterMatches(info, filter)),
        ),
      ),

    streamEvents: (ref) =>
      client.streamEvents(ref as unknown as string) as Stream.Stream<FileSyncEventChunk, FileSyncError>,
  } satisfies FileSyncEngineShape;
};

/**
 * Bundled Live Layer for consumers that include the plugin before running
 * `lando setup`. The default client fails closed until a real Mutagen client
 * is supplied by a later layer.
 */
export const engine = Layer.succeed(FileSyncEngine, makeFileSyncEngine());

/** Test seam for building the Layer against a caller-supplied client. */
export const makeEngineLayer = (options: MakeFileSyncEngineOptions = {}) =>
  Layer.succeed(FileSyncEngine, makeFileSyncEngine(options));

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Mutagen-backed FileSyncEngine for accelerated bind mounts on slow-bind-mount providers.",
  enabled: true,
  contributes: { fileSyncEngines: [ENGINE_ID] },
  entry: "./src/index.ts",
});

export {
  type FakeMutagenClient,
  type MutagenClient,
  type MutagenCreateArgs,
  type MutagenSessionRecord,
  MUTAGEN_FAKE_SENTINELS,
  makeFakeMutagenClient,
  makeUnavailableMutagenClient,
  toFileSyncSessionInfo,
} from "./mutagen-client.ts";

export {
  MUTAGEN_NAME_MAX,
  isValidMutagenSessionName,
  mutagenSessionName,
  mutagenSessionNameFromParts,
  mutagenSessionRef,
} from "./session-name.ts";

export {
  type ExtractImpl,
  type MutagenBinaryEntry,
  type MutagenDownloader,
  type MutagenSetupOptions,
  type MutagenVersionsManifest,
  MutagenBinaryChecksumError,
  MutagenBinaryDownloadError,
  MutagenBinaryUnsupportedPlatformError,
  MUTAGEN_VERSIONS_MANIFEST,
  defaultExtract,
  hostPlatformKey,
  makeMutagenDownloader,
  mutagenAgentBinaryPath,
  mutagenHostBinaryPath,
  mutagenInstalledVersionPath,
  readInstalledMutagenStatus,
  readInstalledMutagenVersion,
} from "./download.ts";
