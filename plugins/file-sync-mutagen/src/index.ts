/**
 * Mutagen-backed accelerated file sync for the managed Lando provider on
 * native Windows. The production contribution binds verified provider targets
 * before creating durable sessions; in-memory clients support contract tests.
 */

import path from "node:path";
import { Effect, Layer, Schema, type Scope, type Stream } from "effect";

import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { LandoPluginContext } from "@lando/sdk/plugins";
import {
  type PluginDoctorCheckContribution,
  type PluginDoctorReport,
  definePlugin,
} from "@lando/sdk/plugins";
import {
  type AppPlan,
  type FileSyncEngineCapabilities as FileSyncEngineCapabilitiesType,
  type FileSyncEventChunk,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  type FileSyncSessionRef,
  type FileSyncSessionSpec,
  type FileSyncSetupOptions,
  PluginManifest,
  type PreparedFileSyncTarget,
} from "@lando/sdk/schema";
import {
  Downloader,
  FileSyncEngine,
  type FileSyncEngineShape,
  type FileSyncError,
  PathsService,
  ProcessRunner,
} from "@lando/sdk/services";
import type { ToolError } from "@lando/sdk/tool-provisioning";

import {
  dockerCliConfigDir,
  dockerCliInstallPath,
  provisionDockerCli,
  readInstalledDockerCliStatus,
} from "./docker-cli-provision.ts";
import { type MutagenClient, makeUnavailableMutagenClient, toFileSyncSessionInfo } from "./mutagen-client.ts";
import { WINDOWS_LANDO_DOCKER_HOST, makeMutagenProcessClient } from "./mutagen-process-client.ts";
import { MUTAGEN_TOOL_VERSION, provisionMutagen, readInstalledMutagenStatus } from "./provision.ts";
import { mutagenSessionName, mutagenSessionRef } from "./session-name.ts";
import { makePreparedWindowsMutagenAppClient } from "./windows-app-client.ts";

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
    (info.app.kind !== filter.app.kind ||
      info.app.id !== filter.app.id ||
      !sameRealpath(info.app.root, filter.app.root))
  ) {
    return false;
  }
  if (filter.service !== undefined && info.service !== filter.service) return false;
  if (filter.mountKey !== undefined && info.mountKey !== filter.mountKey) return false;
  return true;
};

export interface MakeFileSyncEngineOptions {
  /** Override the underlying Mutagen transport. Tests can pass
   *  `makeFakeMutagenClient()`; the unbound default fails closed until
   *  verified provider targets are bound. */
  readonly client?: MutagenClient;
  readonly setup?:
    | ((options: FileSyncSetupOptions) => Effect.Effect<void, FileSyncError, Scope.Scope>)
    | undefined;
  readonly availability?: Effect.Effect<boolean, FileSyncError>;
  readonly bindPreparedTargets?: (
    plan: AppPlan,
    targets: ReadonlyArray<PreparedFileSyncTarget>,
  ) => Effect.Effect<
    FileSyncEngineShape & { readonly boundApp: FileSyncSessionSpec["app"] },
    FileSyncStartError
  >;
}

/**
 * Build the `FileSyncEngine` service. With no options it uses
 * `makeUnavailableMutagenClient()`, which fails closed with the standard
 * unavailable-client remediation. Tests can pass a fake client (see
 * `makeFakeMutagenClient`) for deterministic in-memory coverage.
 */
export const makeFileSyncEngine = (options: MakeFileSyncEngineOptions = {}): FileSyncEngineShape => {
  const client = options.client ?? makeUnavailableMutagenClient();

  const createSession = Effect.fn("FileSyncEngine.createSession")(function* (
    spec: FileSyncSessionSpec,
  ): Effect.fn.Return<FileSyncSessionRef, FileSyncError, Scope.Scope> {
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

    if (client.persistsAcrossProcesses !== true) {
      yield* Effect.addFinalizer(() => client.terminate(name).pipe(Effect.orDie));
    }

    return mutagenSessionRef(spec);
  });

  return FileSyncEngine.of({
    id: ENGINE_ID,
    displayName: ENGINE_DISPLAY_NAME,
    capabilities:
      client.persistsAcrossProcesses === true
        ? { ...mutagenCapabilities, conflictReporting: false, progressReporting: false }
        : mutagenCapabilities,
    sessionsPersistAcrossProcesses: client.persistsAcrossProcesses === true,
    ...(client.invalidateAppDrain !== undefined &&
    client.drainApp !== undefined &&
    client.disposeApp !== undefined &&
    client.completeAppDisposal !== undefined &&
    client.disposalPhase !== undefined
      ? {
          appLifecycle: {
            invalidateDrain: client.invalidateAppDrain,
            drain: client.drainApp,
            dispose: client.disposeApp,
            completeDisposal: client.completeAppDisposal,
            disposalPhase: client.disposalPhase,
          },
        }
      : {}),

    ...(options.bindPreparedTargets === undefined
      ? {}
      : { bindPreparedTargets: options.bindPreparedTargets }),
    isAvailable:
      options.availability ??
      client.version.pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    setup: Effect.fn("FileSyncEngine.setup")(options.setup ?? (() => Effect.void)),

    createSession,

    flushSession: Effect.fn("FileSyncEngine.flushSession")((ref) => client.flush(ref as unknown as string)),
    pauseSession: Effect.fn("FileSyncEngine.pauseSession")((ref) => client.pause(ref as unknown as string)),
    resumeSession: Effect.fn("FileSyncEngine.resumeSession")(
      (ref) => client.resume(ref as unknown as string) as Effect.Effect<void, FileSyncError, never>,
    ),
    terminateSession: Effect.fn("FileSyncEngine.terminateSession")((ref) =>
      client.terminate(ref as unknown as string),
    ),

    listSessions: Effect.fn("FileSyncEngine.listSessions")((filter) =>
      client.list.pipe(
        Effect.map((records) =>
          records.map(toFileSyncSessionInfo).filter((info) => filterMatches(info, filter)),
        ),
      ),
    ),

    streamEvents: (ref) =>
      client.streamEvents(ref as unknown as string) as Stream.Stream<FileSyncEventChunk, FileSyncError>,
  });
};

/**
 * Test layer without a provider-bound target. Production uses the contextual
 * contribution, which binds verified managed Windows targets before create.
 */
const provisionError = (cause: ToolError): FileSyncStartError =>
  new FileSyncStartError({
    engineId: ENGINE_ID,
    message: `Failed to provision Mutagen ${MUTAGEN_TOOL_VERSION}.`,
    remediation: "Retry `lando setup`; if the problem persists, inspect the Mutagen tool manifest.",
    cause,
  });

export const layer = Layer.effect(
  FileSyncEngine,
  Effect.gen(function* () {
    const paths = yield* PathsService;
    const downloader = yield* Downloader;
    return makeFileSyncEngine({
      setup: (setupOptions) =>
        provisionMutagen({
          binDir: paths.binDir,
          toolDownloadsDir: paths.toolDownloadsDir("mutagen"),
          force: setupOptions.force,
        }).pipe(Effect.provideService(Downloader, downloader), Effect.mapError(provisionError)),
    });
  }),
);

export const layerForContext = (ctx: LandoPluginContext) =>
  Layer.effect(
    FileSyncEngine,
    Effect.gen(function* () {
      const paths = yield* PathsService;
      const downloader = yield* Downloader;
      const runner = yield* ProcessRunner;
      const setup: MakeFileSyncEngineOptions["setup"] = (options) =>
        provisionMutagen({
          binDir: paths.binDir,
          toolDownloadsDir: paths.toolDownloadsDir("mutagen"),
          force: options.force,
        }).pipe(
          Effect.andThen(
            paths.platform === "win32"
              ? provisionDockerCli({
                  binDir: paths.binDir,
                  toolDownloadsDir: paths.toolDownloadsDir("mutagen-docker"),
                  force: options.force,
                })
              : Effect.void,
          ),
          Effect.provideService(Downloader, downloader),
          Effect.provideService(ProcessRunner, runner),
          Effect.mapError(provisionError),
        );
      if (paths.platform !== "win32") return makeFileSyncEngine({ setup });

      const dockerCliPath = dockerCliInstallPath(paths.binDir);
      const verifyDockerCli = () =>
        Effect.tryPromise({
          try: () => readInstalledDockerCliStatus(paths.binDir),
          catch: () =>
            new FileSyncStartError({
              engineId: ENGINE_ID,
              message: "Could not verify Lando-managed Docker CLI for Mutagen.",
              remediation: "Run lando setup and retry file sync.",
            }),
        }).pipe(
          Effect.flatMap((status) =>
            status.isCurrent
              ? Effect.succeed(dockerCliPath)
              : Effect.fail(
                  new FileSyncStartError({
                    engineId: ENGINE_ID,
                    message: "Lando-managed Docker CLI for Mutagen is missing or has changed.",
                    remediation: "Run lando setup and retry file sync.",
                  }),
                ),
          ),
        );
      const availability = Effect.all([
        Effect.promise(() => readInstalledMutagenStatus(paths.binDir)),
        Effect.promise(() => readInstalledDockerCliStatus(paths.binDir)),
      ]).pipe(Effect.map(([mutagen, docker]) => mutagen.isCurrent && docker.isCurrent));
      const common = {
        binDir: paths.binDir,
        dataDir: paths.fileSyncSessionsDir,
        dockerCliPath,
        dockerConfigDir: dockerCliConfigDir(paths.binDir),
        dockerHost: WINDOWS_LANDO_DOCKER_HOST,
        runner,
        stateStore: ctx.stateStore,
        verifyDockerCli,
      };
      const client = makeMutagenProcessClient({
        ...common,
        resolveTarget: () =>
          Effect.fail(
            new FileSyncStartError({
              engineId: ENGINE_ID,
              message: "File-sync session creation requires verified provider targets.",
              remediation: "Retry app start after preparing the complete accelerated mount target set.",
            }),
          ),
      });
      const bindPreparedTargets: NonNullable<MakeFileSyncEngineOptions["bindPreparedTargets"]> = (
        plan,
        targets,
      ) => {
        const first = plan.fileSync[0];
        if (first === undefined)
          return Effect.fail(
            new FileSyncStartError({
              engineId: ENGINE_ID,
              message: "The app plan has no accelerated sessions to bind.",
              remediation: "Prepare a nonempty accelerated mount plan before binding Mutagen.",
            }),
          );
        return makePreparedWindowsMutagenAppClient({
          ...common,
          plan,
          preparedTargets: { targets },
          prepareDockerCli: verifyDockerCli,
          deferPreparation: true,
        }).pipe(
          Effect.map((boundClient) => ({
            ...makeFileSyncEngine({ client: boundClient, setup, availability }),
            boundApp: first.session.app,
          })),
        );
      };
      return makeFileSyncEngine({ client, setup, availability, bindPreparedTargets });
    }),
  );

export const fileSyncCheck: PluginDoctorCheckContribution = {
  id: "file-sync",
  relevant: (capabilities) => capabilities.bindMountPerformance === "slow",
  run: Effect.fn("MutagenDoctorCheck.run")(function* ({ binDir, platform, providerId }) {
    const installStatus =
      binDir === undefined ? undefined : yield* Effect.promise(() => readInstalledMutagenStatus(binDir));
    const installedVersion = installStatus?.installedVersion;
    const isCurrent = installStatus?.isCurrent === true;
    const supported = platform === "win32" && providerId === "lando";
    const dockerStatus =
      supported && binDir !== undefined
        ? yield* Effect.promise(() => readInstalledDockerCliStatus(binDir))
        : undefined;
    // Doctor is composed beside, not inside, the engine layer. Verified tool
    // fingerprints and supported provider/host identify the installed adapter.
    const clientReady = supported && isCurrent && dockerStatus?.isCurrent === true;
    const ready = clientReady;

    return [
      {
        name: "file-sync",
        status: ready ? "pass" : "warn",
        severity: ready ? "info" : "warn",
        runtimeStatus:
          installedVersion === undefined
            ? "not-installed"
            : isCurrent && !clientReady
              ? "installed-client-unavailable"
              : "installed",
        context: {
          engineId: ENGINE_ID,
          mutagenVersion: installedVersion ?? "not-installed",
          expectedVersion: MUTAGEN_TOOL_VERSION,
          clientStatus: clientReady ? "available" : "unavailable",
        },
        solutions: ready
          ? []
          : !isCurrent
            ? [
                {
                  kind: "manual",
                  description: "Run `lando setup` to download the Mutagen host CLI and agent binaries.",
                  command: "lando setup",
                },
              ]
            : supported && dockerStatus?.isCurrent !== true
              ? [
                  {
                    kind: "manual",
                    description: "Run `lando setup` to install the verified Docker CLI for Mutagen.",
                    command: "lando setup",
                  },
                ]
              : [
                  {
                    kind: "manual",
                    description: supported
                      ? "Retry `lando setup` and check the selected file-sync engine."
                      : "Accelerated Mutagen sync is currently supported by the Lando-managed provider on native Windows.",
                  },
                ],
      },
    ] satisfies ReadonlyArray<PluginDoctorReport>;
  }),
};

/** Test seam for building the Layer against a caller-supplied client. */
export const layerWith = (options: MakeFileSyncEngineOptions = {}) =>
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

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  fileSyncEngines: new Map([[ENGINE_ID, { make: layerForContext }]]),
  doctorChecks: [fileSyncCheck],
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
  MUTAGEN_TOOL_MANIFEST,
  MUTAGEN_TOOL_VERSION,
  type InstalledMutagenStatus,
  type ProvisionMutagenInput,
  mutagenAgentInstallPath,
  mutagenHostInstallName,
  mutagenHostInstallPath,
  mutagenInstalledVersionPath,
  provisionMutagen,
  readInstalledMutagenStatus,
} from "./provision.ts";

export {
  type MutagenProcessClientOptions,
  type PreparedWindowsMutagenProcessClientOptions,
  WINDOWS_LANDO_DOCKER_HOST,
  makeMutagenProcessClient,
  makePreparedWindowsMutagenProcessClient,
} from "./mutagen-process-client.ts";

export {
  type PreparedWindowsMutagenAppClientOptions,
  type PreparedWindowsMutagenTargets,
  makePreparedWindowsMutagenAppClient,
} from "./windows-app-client.ts";
