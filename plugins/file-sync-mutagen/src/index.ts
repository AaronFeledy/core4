/**
 * `@lando/file-sync-mutagen` — bundled Mutagen-backed `FileSyncEngine`
 * for accelerated bind mounts on `bindMountPerformance: "slow"` providers
 * (`provider-lando` on macOS, `provider-docker` on macOS / Windows,
 * `provider-podman` on macOS / Windows).
 *
 * US-096 ships the engine + Live Layer + deterministic session naming +
 * the `MutagenClient` seam against an in-memory fake. US-097 will wire
 * the real Mutagen host CLI download, and US-098 will plumb the engine
 * into `AppPlanner` so users on slow-bind-mount providers pay zero
 * configuration.
 *
 * Capability matrix is fixed per `spec/11-subsystems.md` §10.6.2:
 *   `modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"]`,
 *   `remoteAgentDeployment: "auto"`, `exclusionPatterns: true`,
 *   `conflictReporting: true`, `progressReporting: true`.
 */

import { Effect, Layer, Schema, type Stream } from "effect";

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

import { type MutagenClient, makeUnavailableMutagenClient, toFileSyncSessionInfo } from "./mutagen-client.ts";
import { mutagenSessionName, mutagenSessionRef } from "./session-name.ts";

export const PLUGIN_NAME = "@lando/file-sync-mutagen" as const;
export const ENGINE_ID = "mutagen" as const;
export const ENGINE_DISPLAY_NAME = "Mutagen" as const;

/**
 * Capability matrix for the bundled Mutagen engine. Per
 * `spec/11-subsystems.md` §10.6.2 this is a fixed declaration; it does
 * not depend on host platform or daemon state.
 */
export const mutagenCapabilities: FileSyncEngineCapabilitiesType = {
  modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"],
  remoteAgentDeployment: "auto",
  exclusionPatterns: true,
  conflictReporting: true,
  progressReporting: true,
};

const sourceIsInsideAppRoot = (spec: FileSyncSessionSpec): boolean => {
  const root = spec.app.root;
  return spec.source === root || spec.source.startsWith(`${root}/`);
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
  /** Override the underlying Mutagen transport. Tests pass
   *  `makeFakeMutagenClient()`; US-097 will wire the real
   *  host-CLI-backed client here. */
  readonly client?: MutagenClient;
}

/**
 * Construct the `FileSyncEngine` service. The default (no options) uses
 * `makeUnavailableMutagenClient()`, which fails closed with the standard
 * "run `lando setup`" remediation. Tests pass a fake client (see
 * `makeFakeMutagenClient`) for deterministic in-memory coverage.
 */
export const makeFileSyncEngine = (options: MakeFileSyncEngineOptions = {}): FileSyncEngineShape => {
  const client = options.client ?? makeUnavailableMutagenClient();

  const createSession = (
    spec: FileSyncSessionSpec,
  ): Effect.Effect<FileSyncSessionRef, FileSyncError, never> =>
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
    }) as unknown as Effect.Effect<FileSyncSessionRef, FileSyncError, never>;

  return {
    id: ENGINE_ID,
    displayName: ENGINE_DISPLAY_NAME,
    capabilities: mutagenCapabilities,

    isAvailable: client.version.pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
    setup: (_options: FileSyncSetupOptions) => Effect.void,

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
 * Bundled Live Layer. The default uses `makeUnavailableMutagenClient()`
 * so consumers who include the plugin without yet running `lando setup`
 * get an actionable remediation. US-097 swaps this for a Layer that
 * builds the real Mutagen-host-CLI client.
 */
export const engine = Layer.succeed(FileSyncEngine, makeFileSyncEngine());

/** Test seam: build the Layer against a caller-supplied client. */
export const makeEngineLayer = (options: MakeFileSyncEngineOptions = {}) =>
  Layer.succeed(FileSyncEngine, makeFileSyncEngine(options));

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
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
