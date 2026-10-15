import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Context, DateTime, Duration, Effect, Schema, Stream } from "effect";

import { sameRealpath } from "@lando/paths";
import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { runProbe } from "@lando/sdk/probe";
import { FileSyncSessionSpec, type FileSyncSessionStatus } from "@lando/sdk/schema";
import type { ProcessResult, ProcessRunner, StateBucket } from "@lando/sdk/services";

import type { MutagenClient, MutagenSessionRecord } from "./mutagen-client.ts";
import { mutagenHostInstallPath, readInstalledMutagenStatus } from "./provision.ts";

const ENGINE_ID = "mutagen" as const;
const LIST_TEMPLATE = "{{ json . }}";
const IDENTIFIER = /^sync_[A-Za-z0-9]+$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const FLUSH_TIMEOUT_MS = 1_800_000;
const REMEDIATION =
  "Stop the app and retry; if the session changed outside Lando, inspect Mutagen's isolated session data before removing it.";

type TaggedSyncError<E> = Extract<E, FileSyncStartError | FileSyncDriftError | FileSyncStopError>;

type Runner = Pick<Context.Service.Shape<typeof ProcessRunner>, "run">;

const sameAppRef = (left: FileSyncSessionSpec["app"], right: FileSyncSessionSpec["app"]): boolean =>
  left.kind === right.kind && left.id === right.id && sameRealpath(left.root, right.root);

const sameOwnedSessionSpec = (owned: FileSyncSessionSpec, planned: FileSyncSessionSpec): boolean => {
  const { app: ownedApp, source: ownedSource, ...ownedRest } = owned;
  const { app: plannedApp, source: plannedSource, ...plannedRest } = planned;
  return (
    sameAppRef(ownedApp, plannedApp) &&
    sameRealpath(ownedSource, plannedSource) &&
    isDeepStrictEqual(ownedRest, plannedRest)
  );
};

interface Endpoint {
  readonly protocol: string;
  readonly host?: string;
  readonly path: string;
  readonly connected?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly permissions?: {
    readonly defaultOwner?: string;
    readonly defaultGroup?: string;
    readonly defaultFileMode?: string;
    readonly defaultDirectoryMode?: string;
  };
  readonly scanProblems?: ReadonlyArray<unknown>;
  readonly transitionProblems?: ReadonlyArray<unknown>;
  readonly excludedTransitionProblems?: number;
}

interface InspectedSession {
  readonly identifier: string;
  readonly name: string;
  readonly alpha: Endpoint;
  readonly beta: Endpoint;
  readonly mode: string;
  readonly ignore?: { readonly paths?: ReadonlyArray<string> };
  readonly paused: boolean;
  readonly status: string;
  readonly successfulCycles?: number;
  readonly conflicts?: ReadonlyArray<unknown>;
  readonly lastError?: string;
}

interface OwnedSession {
  readonly identifier: string;
  readonly name: string;
  readonly spec: FileSyncSessionSpec;
  readonly target: {
    readonly containerId: string;
    readonly path: string;
    readonly permissions?: {
      readonly owner: string;
      readonly group: string;
      readonly defaultFileMode: string;
      readonly defaultDirectoryMode: string;
    };
  };
}

const SessionReceipt = Schema.Struct({
  phase: Schema.Literals(["preparing", "committed", "disposing", "disposed"]),
  identifier: Schema.optionalKey(Schema.String),
  name: Schema.String,
  spec: FileSyncSessionSpec,
  target: Schema.Struct({
    containerId: Schema.String,
    path: Schema.String,
    permissions: Schema.optionalKey(
      Schema.Struct({
        owner: Schema.String,
        group: Schema.String,
        defaultFileMode: Schema.String,
        defaultDirectoryMode: Schema.String,
      }),
    ),
  }),
  dataDir: Schema.String,
  dockerHost: Schema.String,
});
type SessionReceipt = Schema.Schema.Type<typeof SessionReceipt>;
const AppDrain = Schema.Struct({
  app: FileSyncSessionSpec.fields.app,
  phase: Schema.Literals(["invalidated", "preparing", "drained", "disposing", "completed"]),
  identifiers: Schema.Array(Schema.String),
});
type AppDrain = Schema.Schema.Type<typeof AppDrain>;
const SessionLedger = Schema.Struct({
  sessions: Schema.Array(SessionReceipt),
  appDrains: Schema.optionalKey(Schema.Array(AppDrain)),
});
type SessionLedger = Schema.Schema.Type<typeof SessionLedger>;
const EMPTY_LEDGER: SessionLedger = { sessions: [] };
const openLedger = (stateStore: PluginStateStore) =>
  stateStore.open({
    namespace: "sessions",
    key: "mutagen.json",
    schema: SessionLedger,
    version: 1,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
  });

/** Read-only ownership check for lifecycle guards, usable when Mutagen itself is unavailable. */
export const hasDurableMutagenOwnership = (
  stateStore: PluginStateStore,
  app?: FileSyncSessionSpec["app"],
): Effect.Effect<boolean, FileSyncStartError> =>
  stateStore
    .withLock(
      "mutagen-sessions",
      openLedger(stateStore).pipe(
        Effect.flatMap(readKnownLedger),
        Effect.map((ledger) =>
          ledger.sessions.some((entry) => app === undefined || sameAppRef(entry.spec.app, app)),
        ),
      ),
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof FileSyncStartError
          ? error
          : startError("Could not read Mutagen session ownership state."),
      ),
    );

export interface MutagenProcessClientOptions {
  /** Provisioned, checksum-verified tool location. */
  readonly binDir: string;
  /** Lando-owned daemon directory; never Mutagen's user default. */
  readonly dataDir: string;
  /** The Docker-compatible CLI shipped by the selected provider; its directory is used for Mutagen discovery. */
  readonly dockerCliPath: string;
  /** Recheck a provider-prepared CLI before every subprocess, including later commands. */
  readonly verifyDockerCli?: (() => Effect.Effect<string, FileSyncStartError>) | undefined;
  /** Verified provider socket, e.g. npipe:////./pipe/podman-lando on Windows. */
  readonly dockerHost: string;
  readonly dockerConfigDir?: string;
  readonly runner: Runner;
  /** Plugin-scoped durable state and cross-process advisory lock. */
  readonly stateStore: PluginStateStore;
  /** Provider-owned helper container already attached to the target volume. */
  readonly resolveTarget: (spec: FileSyncSessionSpec) => Effect.Effect<
    {
      readonly containerId: string;
      readonly path: string;
      readonly permissions?: {
        readonly owner: string;
        readonly group: string;
        readonly defaultFileMode: string;
        readonly defaultDirectoryMode: string;
      };
    },
    FileSyncStartError
  >;
  readonly platform?: string;
  readonly arch?: string;
  /** Only injected by tests; production always checks installed fingerprints. */
  readonly verifyInstalled?: () => Promise<boolean>;
}

const startError = (message: string, spec?: FileSyncSessionSpec): FileSyncStartError =>
  new FileSyncStartError({
    engineId: ENGINE_ID,
    message,
    ...(spec === undefined ? {} : { sessionSpec: spec }),
    remediation: REMEDIATION,
  });

const stopError = (message: string, name: string): FileSyncStopError =>
  new FileSyncStopError({ engineId: ENGINE_ID, sessionRef: name, message, remediation: REMEDIATION });

const readKnownLedger = (bucket: StateBucket<SessionLedger>) =>
  bucket.get.pipe(
    Effect.flatMap((value) =>
      value !== null
        ? Effect.succeed(value)
        : bucket.exists.pipe(
            Effect.flatMap((exists) =>
              exists
                ? Effect.fail(
                    startError(
                      "Mutagen session ownership state has an unknown version; inspect the durable ledger before retrying.",
                    ),
                  )
                : Effect.succeed(EMPTY_LEDGER),
            ),
          ),
    ),
  );

const parseSessions = (output: string): ReadonlyArray<InspectedSession> => {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("Mutagen returned a non-array session list.");
  return value.map((item: unknown): InspectedSession => {
    if (typeof item !== "object" || item === null) throw new Error("Invalid Mutagen session.");
    const row = item as Record<string, unknown>;
    const alpha = row.alpha as Record<string, unknown> | undefined;
    const beta = row.beta as Record<string, unknown> | undefined;
    if (
      typeof row.identifier !== "string" ||
      !IDENTIFIER.test(row.identifier) ||
      typeof row.name !== "string" ||
      typeof row.mode !== "string" ||
      typeof row.status !== "string" ||
      typeof row.paused !== "boolean" ||
      alpha === undefined ||
      beta === undefined ||
      typeof alpha.protocol !== "string" ||
      typeof alpha.path !== "string" ||
      typeof beta.protocol !== "string" ||
      typeof beta.path !== "string"
    )
      throw new Error("Mutagen returned incomplete session metadata.");
    return item as InspectedSession;
  });
};

const pathMatches = (expected: string, observed: string, platform: string): boolean =>
  platform === "win32"
    ? path.win32.normalize(expected).toLowerCase() === path.win32.normalize(observed).toLowerCase()
    : path.posix.normalize(expected) === path.posix.normalize(observed);

const sameStrings = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const exactSession = (
  owned: OwnedSession,
  observed: InspectedSession,
  dockerHost: string,
  dockerConfigDir?: string,
): boolean =>
  observed.name === owned.name &&
  observed.identifier === owned.identifier &&
  observed.alpha.protocol === "local" &&
  sameRealpath(owned.spec.source, observed.alpha.path) &&
  observed.beta.protocol === "docker" &&
  observed.beta.host === owned.target.containerId &&
  observed.beta.path === owned.target.path &&
  observed.mode === owned.spec.mode &&
  sameStrings(owned.spec.excludes, observed.ignore?.paths ?? []) &&
  observed.beta.environment?.DOCKER_HOST === dockerHost &&
  (dockerConfigDir === undefined || observed.beta.environment?.DOCKER_CONFIG === dockerConfigDir) &&
  (observed.beta.environment?.DOCKER_CONTEXT ?? "") === "" &&
  (owned.target.permissions === undefined ||
    (observed.beta.permissions?.defaultOwner === `id:${owned.target.permissions.owner}` &&
      observed.beta.permissions?.defaultGroup === `id:${owned.target.permissions.group}` &&
      observed.beta.permissions?.defaultFileMode === owned.target.permissions.defaultFileMode &&
      observed.beta.permissions?.defaultDirectoryMode === owned.target.permissions.defaultDirectoryMode));

const healthy = (session: InspectedSession): boolean =>
  !session.paused &&
  session.status === "watching" &&
  session.alpha.connected === true &&
  session.beta.connected === true &&
  (session.successfulCycles ?? 0) > 0 &&
  (session.conflicts?.length ?? 0) === 0 &&
  (session.alpha.scanProblems?.length ?? 0) === 0 &&
  (session.beta.scanProblems?.length ?? 0) === 0 &&
  (session.alpha.transitionProblems?.length ?? 0) === 0 &&
  (session.beta.transitionProblems?.length ?? 0) === 0 &&
  !session.lastError;

const safeRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !path.posix.isAbsolute(value) &&
  !value.includes("\\") &&
  !value.includes(":") &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
  !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

const safeProblemPaths = (
  problems: ReadonlyArray<unknown>,
  key: "root" | "path",
  limit: number,
): Array<string> => {
  const paths = new Set<string>();
  for (const problem of problems) {
    if (typeof problem !== "object" || problem === null || !(key in problem)) continue;
    const candidate = (problem as Record<string, unknown>)[key];
    if (!safeRelativePath(candidate)) continue;
    paths.add(candidate);
    if (paths.size === limit) break;
  }
  return [...paths];
};

const safeConflictPaths = (conflicts: ReadonlyArray<unknown>): Array<string> =>
  safeProblemPaths(conflicts, "root", 32);

type TransitionProblemCategory =
  | "access denied"
  | "read-only filesystem"
  | "insufficient disk space"
  | "file in use";

const transitionProblemCategory = (problem: unknown): TransitionProblemCategory | undefined => {
  if (typeof problem !== "object" || problem === null || !("error" in problem)) return undefined;
  const error = problem.error;
  if (typeof error !== "string") return undefined;
  const bounded = error.slice(0, 1_024);
  if (/access is denied|permission denied|operation not permitted/i.test(bounded)) return "access denied";
  if (/read.only file system|read.only filesystem/i.test(bounded)) return "read-only filesystem";
  if (/no space left|disk full|insufficient disk space/i.test(bounded)) return "insufficient disk space";
  if (/sharing violation|used by another process|being used by another process/i.test(bounded))
    return "file in use";
  return undefined;
};

const transitionProblemDiagnostic = (
  session: InspectedSession,
  owned: Pick<OwnedSession, "identifier" | "name" | "spec" | "target">,
): { readonly message: string; readonly remediation: string } | undefined => {
  const endpoints = [
    { endpoint: session.alpha, label: "Windows host (alpha)", location: String(owned.spec.source) },
    { endpoint: session.beta, label: "container helper (beta)", location: owned.target.containerId },
  ] as const;
  const affected = endpoints.flatMap(({ endpoint, label, location }) => {
    const problems = endpoint.transitionProblems ?? [];
    const excluded = endpoint.excludedTransitionProblems;
    const count =
      problems.length +
      (Number.isSafeInteger(excluded) && excluded !== undefined && excluded > 0 ? excluded : 0);
    if (count === 0) return [];
    const paths = safeProblemPaths(problems, "path", 8);
    const categories = [
      ...new Set(problems.map(transitionProblemCategory).filter((value) => value !== undefined)),
    ];
    return [{ label, location, count, paths, categories }];
  });
  if (affected.length === 0) return undefined;
  const summary = affected
    .map(({ label, count, paths, categories }) => {
      const category = categories.length > 0 ? ` (${categories.join(", ")})` : "";
      const examples = paths.length > 0 ? ` at ${paths.join(", ")}` : "";
      return `${count} ${label} file update ${count === 1 ? "problem" : "problems"}${category}${examples}`;
    })
    .join("; ");
  const remediation = [
    `Inspect the exact Mutagen session ${owned.identifier} and preserve any needed file versions. The listed paths are relative to their endpoint root.`,
    ...affected.flatMap(({ label, location, categories }) => {
      const host = label === "Windows host (alpha)";
      const where = host ? `Windows source "${location}"` : `verified helper "${location}"`;
      const advice = [
        `Inspect the affected files in ${where}.`,
        ...(categories.includes("access denied") || categories.includes("read-only filesystem")
          ? [
              "Check read-only attributes and access permissions; correct only files you own after preserving needed versions.",
            ]
          : []),
        ...(categories.includes("insufficient disk space")
          ? [`Free space on the affected ${host ? "Windows host" : "container volume"} before retrying.`]
          : []),
        ...(categories.includes("file in use")
          ? ["Release the process using the affected file before retrying."]
          : []),
      ];
      return [advice.join(" ")];
    }),
    "Retry the command after resolving the reported obstruction.",
  ].join(" ");
  return {
    message: `Mutagen session "${owned.name}" (${owned.identifier}) cannot finish synchronization: ${summary}.`,
    remediation,
  };
};

const activeStatuses = new Set([
  "watching",
  "scanning",
  "reconciling",
  "staging-alpha",
  "staging-beta",
  "transitioning",
  "saving",
  "waiting-for-rescan",
  "connecting-alpha",
  "connecting-beta",
]);

const statusOf = (session: InspectedSession): FileSyncSessionStatus =>
  session.paused
    ? "paused"
    : (session.conflicts?.length ?? 0) > 0 ||
        (session.alpha.scanProblems?.length ?? 0) > 0 ||
        (session.beta.scanProblems?.length ?? 0) > 0 ||
        (session.alpha.transitionProblems?.length ?? 0) > 0 ||
        (session.beta.transitionProblems?.length ?? 0) > 0 ||
        !!session.lastError ||
        !activeStatuses.has(session.status)
      ? "errored"
      : "running";

/**
 * The client records a preparing receipt before daemon create and commits the
 * exact ID after inspection. Every later process verifies that receipt against
 * daemon metadata. Provider helper lifecycle remains an activation prerequisite.
 */
export interface MutagenProcessClient extends MutagenClient {
  /** Invalidate any prior drain before the caller allows app writers to restart. */
  readonly invalidateAppDrain: (app: FileSyncSessionSpec["app"]) => Effect.Effect<void, FileSyncStartError>;
  /** Caller must first quiesce app writers; every invocation flushes all owned sessions. */
  readonly drainApp: (app: FileSyncSessionSpec["app"]) => Effect.Effect<void, FileSyncStopError>;
  /** Terminate the full app set, retaining exact-ID tombstones after all are gone. */
  readonly disposeApp: (app: FileSyncSessionSpec["app"]) => Effect.Effect<void, FileSyncStopError>;
  /** Provider calls after helper and volume cleanup succeeds; clears tombstones. */
  readonly completeAppDisposal: (app: FileSyncSessionSpec["app"]) => Effect.Effect<void, FileSyncStopError>;
  readonly disposalPhase: (
    app: FileSyncSessionSpec["app"],
  ) => Effect.Effect<"absent" | "active" | "drained" | "disposing" | "completed", FileSyncStopError>;
}

/** Keep the Lando-owned Podman pipe confined to the opt-in Windows transport. */
export const WINDOWS_LANDO_DOCKER_HOST = "npipe:////./pipe/podman-lando" as const;

export interface PreparedWindowsMutagenProcessClientOptions
  extends Omit<MutagenProcessClientOptions, "dockerCliPath" | "dockerHost" | "platform" | "verifyDockerCli"> {
  /** Recheck the private Docker CLI selected for the managed Podman endpoint. */
  readonly prepareDockerCli: () => Effect.Effect<string, unknown>;
  /** Known Lando-managed path used when setup must run after binding. */
  readonly dockerCliPath?: string;
  /** Defer installed CLI verification until the first Mutagen command. */
  readonly deferPreparation?: boolean;
  /** Host detection is injectable for cross-platform transport tests. */
  readonly hostPlatform?: string;
}

/**
 * Compose the provider's verified docker.exe alias with Mutagen's docker://
 * transport. This does not activate the bundled FileSyncEngine; the caller
 * must also guarantee populated targets and lifecycle cleanup.
 */
export const makePreparedWindowsMutagenProcessClient = (
  options: PreparedWindowsMutagenProcessClientOptions,
): Effect.Effect<MutagenProcessClient, FileSyncStartError> => {
  const {
    prepareDockerCli,
    dockerCliPath: deferredPath,
    deferPreparation = false,
    hostPlatform = process.platform,
    ...clientOptions
  } = options;
  const prepare = () =>
    hostPlatform !== "win32"
      ? Effect.fail(startError("Windows Mutagen transport requires a Windows host."))
      : prepareDockerCli().pipe(
          Effect.flatMap((cliPath) =>
            path.win32.isAbsolute(cliPath) && path.win32.basename(cliPath).toLowerCase() === "docker.exe"
              ? Effect.succeed(cliPath)
              : Effect.fail(startError("The provider did not prepare an absolute Windows docker.exe path.")),
          ),
          Effect.mapError((error) =>
            error instanceof FileSyncStartError
              ? error
              : startError("Could not verify the managed Docker-compatible CLI for Mutagen."),
          ),
        );

  const makeClient = (dockerCliPath: string) =>
    makeMutagenProcessClient({
      ...clientOptions,
      dockerCliPath,
      dockerHost: WINDOWS_LANDO_DOCKER_HOST,
      platform: "win32",
      verifyDockerCli: () =>
        prepare().pipe(
          Effect.flatMap((current) =>
            pathMatches(dockerCliPath, current, "win32")
              ? Effect.succeed(current)
              : Effect.fail(startError("The prepared Docker CLI changed.")),
          ),
        ),
    });
  if (deferPreparation) {
    return hostPlatform === "win32" &&
      deferredPath !== undefined &&
      path.win32.isAbsolute(deferredPath) &&
      path.win32.basename(deferredPath).toLowerCase() === "docker.exe"
      ? Effect.succeed(makeClient(deferredPath))
      : Effect.fail(startError("A managed absolute Windows docker.exe path is required."));
  }
  return prepare().pipe(Effect.map(makeClient));
};

export const makeMutagenProcessClient = (options: MutagenProcessClientOptions): MutagenProcessClient => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binary = mutagenHostInstallPath(options.binDir, platform);

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const dockerConfigDir = options.dockerConfigDir ?? options.dataDir;
  const env = {
    PATH: [pathApi.dirname(options.dockerCliPath), inheritedPath].filter(Boolean).join(pathApi.delimiter),
    MUTAGEN_DATA_DIRECTORY: options.dataDir,
    MUTAGEN_DOCKER_PATH: pathApi.dirname(options.dockerCliPath),
    DOCKER_HOST: options.dockerHost,
    DOCKER_CONFIG: dockerConfigDir,
    DOCKER_CONTEXT: "",
    DOCKER_TLS: "",
    DOCKER_TLS_VERIFY: "",
    DOCKER_CERT_PATH: "",
    DOCKER_API_VERSION: "",
    CONTAINER_CONNECTION: "",
    CONTAINER_HOST: "",
    MUTAGEN_BETA_DOCKER_HOST: options.dockerHost,
    MUTAGEN_BETA_DOCKER_CONFIG: dockerConfigDir,
    MUTAGEN_BETA_DOCKER_CONTEXT: "",
    MUTAGEN_BETA_DOCKER_TLS: "",
    MUTAGEN_BETA_DOCKER_TLS_VERIFY: "",
    MUTAGEN_BETA_DOCKER_CERT_PATH: "",
    MUTAGEN_BETA_DOCKER_API_VERSION: "",
  };

  const ledger = openLedger(options.stateStore);
  const withLedger = <A, E>(operation: (bucket: StateBucket<SessionLedger>) => Effect.Effect<A, E>) =>
    options.stateStore
      .withLock("mutagen-sessions", ledger.pipe(Effect.flatMap(operation)))
      .pipe(
        Effect.mapError((error) =>
          error instanceof FileSyncStartError ||
          error instanceof FileSyncDriftError ||
          error instanceof FileSyncStopError
            ? (error as TaggedSyncError<E>)
            : startError("Could not read or lock Mutagen session ownership state."),
        ),
      );

  const withAppLock = <A, E>(app: FileSyncSessionSpec["app"], operation: Effect.Effect<A, E>) => {
    const root = pathApi.normalize(app.root);
    const identity = createHash("sha256")
      .update(JSON.stringify([app.kind, app.id, platform === "win32" ? root.toLowerCase() : root]))
      .digest("hex");
    return options.stateStore
      .withLock(`mutagen-app-${identity}`, operation)
      .pipe(
        Effect.mapError((error) =>
          error instanceof FileSyncStartError ||
          error instanceof FileSyncDriftError ||
          error instanceof FileSyncStopError
            ? (error as TaggedSyncError<E>)
            : startError("Could not lock this app's Mutagen sessions."),
        ),
      );
  };

  const writeLedger = (
    bucket: StateBucket<SessionLedger>,
    current: SessionLedger,
    receipt: SessionReceipt | undefined,
    name: string,
  ) =>
    bucket.set({
      ...current,
      sessions: [...current.sessions.filter((entry) => entry.name !== name), ...(receipt ? [receipt] : [])],
    });

  let verified = false;
  const installed = Effect.suspend(() =>
    verified
      ? Effect.void
      : Effect.tryPromise({
          try: async () =>
            options.verifyInstalled === undefined
              ? (await readInstalledMutagenStatus(options.binDir, platform, arch)).isCurrent
              : await options.verifyInstalled(),
          catch: () => startError("Could not verify the installed Mutagen CLI and agent bundle."),
        }).pipe(
          Effect.flatMap((valid) =>
            valid
              ? Effect.sync(() => {
                  verified = true;
                })
              : Effect.fail(
                  startError("The installed Mutagen CLI or agent bundle is missing or has changed."),
                ),
          ),
        ),
  );

  const verifiedTransport =
    options.verifyDockerCli === undefined
      ? Effect.void
      : Effect.suspend(options.verifyDockerCli).pipe(
          Effect.flatMap((current) =>
            pathMatches(options.dockerCliPath, current, platform)
              ? Effect.void
              : Effect.fail(startError("The provider-prepared Docker-compatible CLI changed.")),
          ),
        );

  const run = Effect.fn("MutagenProcessClient.run")(
    (args: ReadonlyArray<string>, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      verifiedTransport.pipe(
        Effect.andThen(installed),
        Effect.flatMap(() => options.runner.run({ cmd: binary, args, env, timeoutMs, windowsHide: true })),
        Effect.mapError((error) =>
          error instanceof FileSyncStartError
            ? error
            : startError(`Mutagen command failed: ${args.slice(0, 2).join(" ")}.`),
        ),
        Effect.flatMap((result: ProcessResult) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                startError(
                  `Mutagen command exited with code ${result.exitCode}: ${args.slice(0, 2).join(" ")}.`,
                ),
              ),
        ),
      ),
  );

  const inspectAll = run(["sync", "list", "--template", LIST_TEMPLATE]).pipe(
    Effect.flatMap((output) =>
      Effect.try({
        try: () => parseSessions(output),
        catch: () => startError("Could not inspect Mutagen session metadata."),
      }),
    ),
  );

  const inspectOwned = (owned: OwnedSession) =>
    inspectAll.pipe(
      Effect.flatMap((listed) => {
        const matching = listed.filter((session) => session.identifier === owned.identifier);
        const observed = matching[0];
        if (
          matching.length !== 1 ||
          observed === undefined ||
          !exactSession(owned, observed, options.dockerHost, options.dockerConfigDir)
        ) {
          return Effect.fail(
            startError(
              `Mutagen session "${owned.name}" no longer matches its expected ID or configuration.`,
              owned.spec,
            ),
          );
        }
        return Effect.succeed(observed);
      }),
    );

  const flushOwned = (owned: OwnedSession) =>
    inspectOwned(owned).pipe(
      Effect.flatMap(() => run(["sync", "flush", owned.identifier], FLUSH_TIMEOUT_MS)),
      Effect.flatMap(() =>
        runProbe(
          {
            id: "mutagen-flush-ready",
            policy: { maxAttempts: 30, delay: Duration.millis(100), timeout: Duration.seconds(5) },
            classify: {
              success: (value) => (healthy(value as InspectedSession) ? "green" : "yellow"),
              failure: () => "red",
            },
          },
          inspectOwned(owned),
        ),
      ),
      Effect.flatMap((result) =>
        result.outcome === "green"
          ? Effect.void
          : inspectOwned(owned).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
              Effect.flatMap((observed): Effect.Effect<never, FileSyncStartError | FileSyncDriftError> => {
                const conflicts = observed?.conflicts ?? [];
                if (conflicts.length > 0) {
                  const paths = safeConflictPaths(conflicts);
                  return Effect.fail(
                    new FileSyncDriftError({
                      engineId: ENGINE_ID,
                      sessionRef: owned.identifier,
                      conflictedPaths: paths,
                      message: `Mutagen session "${owned.name}" (${owned.identifier}) has ${conflicts.length} unresolved synchronization conflict(s)${paths.length > 0 ? `: ${paths.join(", ")}` : ""}.`,
                      remediation: `Preserve both versions before resolving the conflict. Inspect session ${owned.identifier} with the verified Mutagen CLI at "${binary}", isolated session data at "${options.dataDir}", helper "${owned.target.containerId}", Docker CLI "${options.dockerCliPath}", and Docker config "${dockerConfigDir}". Retry after resolving the file versions.`,
                    }),
                  );
                }
                const problem =
                  observed === undefined ? undefined : transitionProblemDiagnostic(observed, owned);
                if (problem !== undefined) {
                  return Effect.fail(
                    new FileSyncStartError({
                      engineId: ENGINE_ID,
                      sessionSpec: owned.spec,
                      message: problem.message,
                      remediation: problem.remediation,
                    }),
                  );
                }
                return Effect.fail(
                  startError(
                    `Mutagen session "${owned.name}" did not complete a healthy synchronization cycle.`,
                    owned.spec,
                  ),
                );
              }),
            ),
      ),
    );

  const receiptOwned = (receipt: SessionReceipt): Effect.Effect<OwnedSession, FileSyncStartError> =>
    receipt.phase !== "preparing" &&
    receipt.identifier !== undefined &&
    IDENTIFIER.test(receipt.identifier) &&
    pathMatches(options.dataDir, receipt.dataDir, platform) &&
    receipt.dockerHost === options.dockerHost
      ? Effect.succeed({ ...receipt, identifier: receipt.identifier })
      : Effect.fail(
          startError(
            `Mutagen session "${receipt.name}" has an incomplete ownership receipt; inspect the isolated daemon before retrying.`,
            receipt.spec,
          ),
        );

  // A create can fail before Mutagen has created anything. A later process may
  // clear that preparing receipt only after the isolated daemon proves that
  // every observed session belongs to another committed receipt.
  const reconcilePreparing = Effect.fnUntraced(function* (
    bucket: StateBucket<SessionLedger>,
    current: SessionLedger,
  ) {
    const preparing = current.sessions.filter((entry) => entry.phase === "preparing");
    if (preparing.length === 0) return current;
    if (
      preparing.some(
        (entry) =>
          !pathMatches(options.dataDir, entry.dataDir, platform) || entry.dockerHost !== options.dockerHost,
      )
    ) {
      return yield* Effect.fail(
        startError("An incomplete Mutagen receipt belongs to a different isolated daemon."),
      );
    }
    const observed = yield* inspectAll;
    const committed = current.sessions.filter((entry) => entry.phase !== "preparing");
    yield* validateInventory({ ...current, sessions: committed }, observed);
    const reconciled: SessionLedger = { ...current, sessions: committed };
    yield* bucket.set(reconciled);
    return reconciled;
  });

  const ownedFor = (bucket: StateBucket<SessionLedger>, name: string) =>
    readKnownLedger(bucket).pipe(
      Effect.flatMap((current) => {
        const matching = current.sessions.filter((entry) => entry.name === name);
        return matching.length === 1 && matching[0] !== undefined
          ? receiptOwned(matching[0]).pipe(Effect.map((owned) => ({ current, owned })))
          : Effect.fail(startError(`Mutagen session "${name}" has no unique Lando ownership receipt.`));
      }),
    );

  const appReceipts = (current: SessionLedger, app: FileSyncSessionSpec["app"]) =>
    current.sessions.filter((entry) => sameAppRef(entry.spec.app, app));

  const appDrain = (current: SessionLedger, app: FileSyncSessionSpec["app"]) =>
    current.appDrains?.find((entry) => sameAppRef(entry.app, app));

  const validateInventory = Effect.fnUntraced(function* (
    current: SessionLedger,
    listed: ReadonlyArray<InspectedSession>,
  ) {
    const names = current.sessions.map((entry) => entry.name);
    const identifiers = current.sessions.map((entry) => entry.identifier);
    if (
      new Set(names).size !== names.length ||
      identifiers.some((identifier) => identifier === undefined) ||
      new Set(identifiers).size !== identifiers.length ||
      new Set(listed.map((entry) => entry.identifier)).size !== listed.length
    ) {
      return yield* Effect.fail(
        startError("Mutagen session ownership contains duplicate or incomplete IDs."),
      );
    }
    const live: Array<{ receipt: SessionReceipt; observed: InspectedSession }> = [];
    for (const receipt of current.sessions) {
      const owned = yield* receiptOwned(receipt);
      const matching = listed.filter((item) => item.identifier === owned.identifier);
      const drains = (current.appDrains ?? []).filter((entry) => sameAppRef(entry.app, receipt.spec.app));
      const drain = drains[0];
      const disposing = drain?.phase === "disposing";
      if (
        drains.length > 1 ||
        ((receipt.phase === "disposing" || receipt.phase === "disposed" || disposing) &&
          (!disposing ||
            !sameStrings(
              drain.identifiers,
              appReceipts(current, receipt.spec.app).map((entry) => entry.identifier ?? ""),
            )))
      ) {
        return yield* Effect.fail(
          startError("Mutagen disposal receipt lacks its exact app disposal marker."),
        );
      }
      if (receipt.phase === "disposed" || (receipt.phase === "disposing" && matching.length === 0)) {
        if (matching.length !== 0) {
          return yield* Effect.fail(startError("Mutagen disposal receipt and daemon inventory disagree."));
        }
        continue;
      }
      const observed = matching[0];
      if (
        matching.length !== 1 ||
        observed === undefined ||
        !exactSession(owned, observed, options.dockerHost, options.dockerConfigDir)
      ) {
        return yield* Effect.fail(
          startError("Mutagen daemon sessions differ from durable ownership receipts."),
        );
      }
      if (disposing && !cleanPaused(observed)) {
        return yield* Effect.fail(
          startError("A Mutagen session resumed or changed after its app began disposal."),
        );
      }
      live.push({ receipt, observed });
    }
    if (live.length !== listed.length) {
      return yield* Effect.fail(startError("Mutagen daemon contains an unowned session."));
    }
    return live;
  });

  const withNamedApp = <A, E>(
    name: string,
    operation: (app: FileSyncSessionSpec["app"]) => Effect.Effect<A, E>,
  ) =>
    withLedger((bucket) => ownedFor(bucket, name).pipe(Effect.map(({ owned }) => owned.spec.app))).pipe(
      Effect.flatMap((app) => withAppLock(app, operation(app))),
    );

  const directMutationAllowed = (
    current: SessionLedger,
    app: FileSyncSessionSpec["app"],
  ): Effect.Effect<void, FileSyncStartError> => {
    const drains = (current.appDrains ?? []).filter((entry) => sameAppRef(entry.app, app));
    return drains.length <= 1 &&
      (drains.length === 0 || drains[0]?.phase === "invalidated" || drains[0]?.phase === "completed")
      ? Effect.void
      : Effect.fail(startError("App Mutagen drain state blocks direct session mutation."));
  };

  const cleanPaused = (observed: InspectedSession) =>
    observed.paused &&
    (observed.conflicts?.length ?? 0) === 0 &&
    (observed.alpha.scanProblems?.length ?? 0) === 0 &&
    (observed.beta.scanProblems?.length ?? 0) === 0 &&
    (observed.alpha.transitionProblems?.length ?? 0) === 0 &&
    (observed.beta.transitionProblems?.length ?? 0) === 0 &&
    !observed.lastError;

  const writeAppDrain = (
    bucket: StateBucket<SessionLedger>,
    current: SessionLedger,
    drain: AppDrain | undefined,
    app: FileSyncSessionSpec["app"],
  ) =>
    bucket.set({
      ...current,
      appDrains: [
        ...(current.appDrains ?? []).filter((entry) => !sameAppRef(entry.app, app)),
        ...(drain === undefined ? [] : [drain]),
      ],
    });

  const validateAppSet = Effect.fnUntraced(function* (
    current: SessionLedger,
    app: FileSyncSessionSpec["app"],
  ) {
    const receipts = appReceipts(current, app);
    if (receipts.some((entry) => entry.phase !== "committed")) {
      return yield* Effect.fail(startError("App has incomplete Mutagen session ownership."));
    }
    const owned = yield* Effect.forEach(receipts, receiptOwned);
    if (
      new Set(owned.map((entry) => entry.identifier)).size !== owned.length ||
      new Set(owned.map((entry) => entry.name)).size !== owned.length
    ) {
      return yield* Effect.fail(startError("App has duplicate Mutagen session ownership."));
    }
    const listed = yield* inspectAll;
    yield* validateInventory(current, listed);
    return owned;
  });

  const invalidateAppDrain = (app: FileSyncSessionSpec["app"]) =>
    withAppLock(
      app,
      withLedger((bucket) =>
        Effect.gen(function* () {
          const current = yield* readKnownLedger(bucket);
          const receipts = appReceipts(current, app);
          if (receipts.some((entry) => entry.phase !== "committed")) {
            return yield* Effect.fail(startError("App has incomplete Mutagen session ownership."));
          }
          const identifiers = receipts.map((entry) => entry.identifier);
          if (identifiers.some((identifier) => identifier === undefined)) {
            return yield* Effect.fail(startError("App has incomplete Mutagen session identifiers."));
          }
          const prior = appDrain(current, app);
          if (receipts.length === 0) {
            if (prior !== undefined) {
              return yield* Effect.fail(startError("App has stale Mutagen drain state without sessions."));
            }
            return;
          }
          if (
            (current.appDrains ?? []).filter((entry) => sameAppRef(entry.app, app)).length > 1 ||
            prior?.phase === "disposing" ||
            (prior !== undefined &&
              prior.phase !== "invalidated" &&
              !sameStrings(prior.identifiers, identifiers as string[]))
          ) {
            return yield* Effect.fail(startError("App Mutagen drain state cannot be invalidated."));
          }
          if (prior?.phase === "preparing") {
            yield* Effect.forEach(receipts, (entry) =>
              receiptOwned(entry).pipe(Effect.flatMap(inspectOwned)),
            );
          }
          yield* writeAppDrain(
            bucket,
            current,
            { app, phase: "invalidated", identifiers: identifiers as string[] },
            app,
          );
        }),
      ),
    );

  const drainApp = (app: FileSyncSessionSpec["app"]) =>
    withAppLock(
      app,
      Effect.gen(function* () {
        const { owned, identifiers, preparing } = yield* withLedger((bucket) =>
          Effect.gen(function* () {
            const current = yield* readKnownLedger(bucket);
            const owned = yield* validateAppSet(current, app);
            if (owned.length === 0) {
              return yield* Effect.fail(startError("App has no Mutagen sessions to drain."));
            }
            const identifiers = owned.map((entry) => entry.identifier);
            const prior = appDrain(current, app);
            if (prior?.phase === "disposing") {
              return yield* Effect.fail(startError("App Mutagen sessions are disposing."));
            }
            if (
              prior !== undefined &&
              prior.phase !== "invalidated" &&
              !sameStrings(prior.identifiers, identifiers)
            ) {
              return yield* Effect.fail(startError("App Mutagen session set changed during drain."));
            }
            const preparing: AppDrain = { app, phase: "preparing", identifiers };
            yield* writeAppDrain(bucket, current, preparing, app);
            return { owned, identifiers, preparing };
          }),
        );
        for (const entry of owned) {
          const observed = yield* inspectOwned(entry);
          if (observed.paused) {
            yield* run(["sync", "resume", entry.identifier]);
            const resumed = yield* inspectOwned(entry);
            if (resumed.paused) {
              return yield* Effect.fail(
                startError(`Mutagen session "${entry.name}" did not resume.`, entry.spec),
              );
            }
          }
          yield* flushOwned(entry).pipe(
            Effect.mapError(
              (error) =>
                new FileSyncStopError({
                  engineId: ENGINE_ID,
                  sessionRef: entry.identifier,
                  message: error.message,
                  remediation:
                    error instanceof FileSyncStartError || error instanceof FileSyncDriftError
                      ? error.remediation
                      : REMEDIATION,
                }),
            ),
          );
        }
        for (const entry of owned) {
          yield* inspectOwned(entry);
          yield* run(["sync", "pause", entry.identifier]);
        }
        for (const entry of owned) {
          const observed = yield* inspectOwned(entry);
          if (!cleanPaused(observed)) {
            return yield* Effect.fail(
              startError(`Mutagen session "${entry.name}" did not reach a clean paused state.`, entry.spec),
            );
          }
        }
        yield* withLedger((bucket) =>
          Effect.gen(function* () {
            const current = yield* readKnownLedger(bucket);
            const recorded = appDrain(current, app);
            const receipts = appReceipts(current, app);
            if (
              recorded?.phase !== "preparing" ||
              !sameStrings(recorded.identifiers, identifiers) ||
              !sameStrings(
                receipts.map((entry) => entry.identifier ?? ""),
                identifiers,
              )
            )
              return yield* Effect.fail(startError("App Mutagen session set changed during drain."));
            yield* writeAppDrain(bucket, current, { ...preparing, phase: "drained" }, app);
          }),
        );
      }),
    ).pipe(
      Effect.mapError((error) =>
        error instanceof FileSyncStopError ? error : stopError(error.message, String(app.id)),
      ),
    );

  const disposeApp = (app: FileSyncSessionSpec["app"]) =>
    withAppLock(
      app,
      withLedger((bucket) =>
        Effect.gen(function* () {
          let current = yield* readKnownLedger(bucket);
          const receipts = appReceipts(current, app);
          if (receipts.some((entry) => entry.phase === "preparing")) {
            return yield* Effect.fail(startError("App has incomplete Mutagen session ownership."));
          }
          const owned = yield* Effect.forEach(receipts, receiptOwned);
          const identifiers = owned.map((entry) => entry.identifier);
          const previous = appDrain(current, app);
          if (
            (previous?.phase !== "drained" && previous?.phase !== "disposing") ||
            !sameStrings(previous.identifiers, identifiers)
          ) {
            return yield* Effect.fail(startError("App Mutagen sessions must be drained before disposal."));
          }
          const listed = yield* inspectAll;
          for (const entry of receipts) {
            const matching = listed.filter((item) => item.identifier === entry.identifier);
            if (entry.phase === "disposed") {
              if (matching.length !== 0) {
                return yield* Effect.fail(
                  startError(`Disposed Mutagen session "${entry.name}" reappeared.`, entry.spec),
                );
              }
            } else if (!(entry.phase === "disposing" && matching.length === 0)) {
              const exact = matching[0];
              const expected = owned.find((item) => item.name === entry.name);
              if (
                matching.length !== 1 ||
                exact === undefined ||
                expected === undefined ||
                !exactSession(expected, exact, options.dockerHost, options.dockerConfigDir)
              ) {
                return yield* Effect.fail(
                  startError(
                    `Mutagen session "${entry.name}" no longer matches its ownership receipt.`,
                    entry.spec,
                  ),
                );
              }
            }
          }
          for (const entry of receipts) {
            if (entry.phase === "disposed") continue;
            const observed = listed.find((item) => item.identifier === entry.identifier);
            if (observed !== undefined && !cleanPaused(observed)) {
              return yield* Effect.fail(
                startError(
                  `Mutagen session "${entry.name}" resumed or developed problems after drain.`,
                  entry.spec,
                ),
              );
            }
          }
          yield* validateInventory(current, listed);
          const disposing: AppDrain = { app, phase: "disposing", identifiers };
          yield* writeAppDrain(bucket, current, disposing, app);
          current = {
            ...current,
            appDrains: [
              ...(current.appDrains ?? []).filter((entry) => !sameAppRef(entry.app, app)),
              disposing,
            ],
          };
          for (const entry of receipts) {
            if (entry.phase === "disposed") continue;
            const marked = { ...entry, phase: "disposing" as const };
            yield* writeLedger(bucket, current, marked, entry.name);
            current = {
              ...current,
              sessions: current.sessions.map((item) => (item.name === entry.name ? marked : item)),
            };
            const exact = yield* inspectAll;
            const matching = exact.filter((item) => item.identifier === entry.identifier);
            if (matching.length === 1 && entry.identifier !== undefined) {
              const observed = yield* inspectOwned({ ...entry, identifier: entry.identifier });
              if (!cleanPaused(observed)) {
                return yield* Effect.fail(
                  startError(
                    `Mutagen session "${entry.name}" resumed or developed problems before termination.`,
                    entry.spec,
                  ),
                );
              }
              yield* run(["sync", "terminate", entry.identifier]);
            } else if (matching.length !== 0) {
              return yield* Effect.fail(startError("Mutagen session ownership became ambiguous."));
            }
            const after = yield* inspectAll;
            if (after.some((item) => item.identifier === entry.identifier)) {
              return yield* Effect.fail(startError("Mutagen session remained after termination."));
            }
            const tombstone = { ...entry, phase: "disposed" as const };
            yield* writeLedger(bucket, current, tombstone, entry.name);
            current = {
              ...current,
              sessions: current.sessions.map((item) => (item.name === entry.name ? tombstone : item)),
            };
          }
        }),
      ),
    ).pipe(Effect.mapError((error) => stopError(error.message, String(app.id))));

  const completeAppDisposal = (app: FileSyncSessionSpec["app"]) =>
    withAppLock(
      app,
      withLedger((bucket) =>
        Effect.gen(function* () {
          const current = yield* readKnownLedger(bucket);
          const receipts = appReceipts(current, app);
          const drain = appDrain(current, app);
          if (drain?.phase === "completed" && receipts.length === 0) {
            const listed = yield* inspectAll;
            if (listed.some((entry) => drain.identifiers.includes(entry.identifier)))
              return yield* Effect.fail(startError("A completed Mutagen session reappeared."));
            return;
          }
          if (
            drain?.phase !== "disposing" ||
            receipts.some((entry) => entry.phase !== "disposed") ||
            !sameStrings(
              drain.identifiers,
              receipts.map((entry) => entry.identifier ?? ""),
            )
          ) {
            return yield* Effect.fail(startError("Mutagen app disposal is not complete."));
          }
          const listed = yield* inspectAll;
          if (listed.some((entry) => drain.identifiers.includes(entry.identifier))) {
            return yield* Effect.fail(startError("A disposed Mutagen session reappeared."));
          }
          yield* validateInventory(current, listed);
          const other = current.sessions.filter((entry) => !sameAppRef(entry.spec.app, app));
          yield* bucket.set({
            ...current,
            sessions: other,
            appDrains: [
              ...(current.appDrains ?? []).filter((entry) => !sameAppRef(entry.app, app)),
              { ...drain, phase: "completed" },
            ],
          });
        }),
      ),
    ).pipe(Effect.mapError((error) => stopError(error.message, String(app.id))));

  const disposalPhase = (app: FileSyncSessionSpec["app"]) =>
    withLedger((bucket) =>
      readKnownLedger(bucket).pipe(
        Effect.flatMap((current) => {
          const receipts = appReceipts(current, app);
          const drains = (current.appDrains ?? []).filter((entry) => sameAppRef(entry.app, app));
          if (drains.length > 1 || receipts.some((entry) => entry.phase === "preparing"))
            return Effect.fail(startError("App has ambiguous Mutagen disposal ownership."));
          const drain = drains[0];
          if (receipts.length === 0 && drain === undefined) return Effect.succeed("absent" as const);
          if (receipts.length === 0 && drain?.phase === "completed")
            return Effect.succeed("completed" as const);
          if (
            receipts.length === 0 ||
            (drain !== undefined &&
              drain.phase !== "invalidated" &&
              drain.identifiers.length !== receipts.length)
          )
            return Effect.fail(startError("App Mutagen session and drain receipts disagree."));
          if (drain === undefined) return Effect.succeed("active" as const);
          if (drain.phase === "disposing")
            return receipts.every(
              (entry) =>
                entry.phase === "committed" || entry.phase === "disposing" || entry.phase === "disposed",
            )
              ? Effect.succeed("disposing" as const)
              : Effect.fail(startError("App Mutagen disposal receipts disagree."));
          if (receipts.some((entry) => entry.phase !== "committed"))
            return Effect.fail(startError("App Mutagen session ownership is incomplete."));
          return Effect.succeed(drain.phase === "drained" ? ("drained" as const) : ("active" as const));
        }),
      ),
    ).pipe(Effect.mapError((error) => stopError(error.message, String(app.id))));

  const create = ({ name, spec }: { readonly name: string; readonly spec: FileSyncSessionSpec }) =>
    withAppLock(
      spec.app,
      Effect.gen(function* () {
        const owned = yield* withLedger((bucket) =>
          Effect.gen(function* () {
            if (spec.target._tag !== "volume" || spec.permissions !== undefined) {
              return yield* Effect.fail(
                startError(
                  "This Mutagen client requires a named volume and currently supports default permissions only.",
                  spec,
                ),
              );
            }
            const loaded = yield* readKnownLedger(bucket);
            yield* directMutationAllowed(loaded, spec.app);
            let current = yield* reconcilePreparing(bucket, loaded);
            const completed = appDrain(current, spec.app)?.phase === "completed";
            if (completed && appReceipts(current, spec.app).length !== 0)
              return yield* Effect.fail(
                startError("Completed app disposal still has Mutagen session receipts."),
              );
            const target = yield* options.resolveTarget(spec);
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(target.containerId) || !target.path.startsWith("/")) {
              return yield* Effect.fail(
                startError("The provider returned an invalid Mutagen helper endpoint.", spec),
              );
            }
            const previous = current.sessions.filter((entry) => entry.name === name);
            if (previous.length > 1) {
              return yield* Effect.fail(
                startError(`Mutagen session "${name}" has duplicate ownership receipts.`, spec),
              );
            }
            if (previous[0] !== undefined) {
              const owned = yield* receiptOwned(previous[0]);
              if (!sameOwnedSessionSpec(owned.spec, spec) || !isDeepStrictEqual(owned.target, target)) {
                return yield* Effect.fail(
                  startError(`Mutagen session "${name}" differs from its ownership receipt.`, spec),
                );
              }
              return owned;
            }
            yield* validateAppSet(current, spec.app);
            const before = yield* inspectAll;
            const sameAppIdentifiers = new Set(
              appReceipts(current, spec.app)
                .filter((entry) => entry.phase === "committed")
                .map((entry) => entry.identifier),
            );
            if (
              before.some(
                (session) =>
                  session.name === name ||
                  (session.beta.protocol === "docker" &&
                    session.beta.host === target.containerId &&
                    session.beta.path === target.path) ||
                  (session.alpha.protocol === "local" &&
                    sameRealpath(spec.source, session.alpha.path) &&
                    !sameAppIdentifiers.has(session.identifier)),
              )
            ) {
              return yield* Effect.fail(
                startError(
                  "A Mutagen session already uses the requested name, source, or helper target; its ownership cannot be proven.",
                  spec,
                ),
              );
            }
            if (completed) {
              yield* writeAppDrain(bucket, current, undefined, spec.app);
              current = {
                ...current,
                appDrains: (current.appDrains ?? []).filter((entry) => !sameAppRef(entry.app, spec.app)),
              };
            }
            const preparing: SessionReceipt = {
              phase: "preparing",
              name,
              spec,
              target,
              dataDir: options.dataDir,
              dockerHost: options.dockerHost,
            };
            yield* writeLedger(bucket, current, preparing, name);
            const args = [
              "sync",
              "create",
              "--no-global-configuration",
              "--name",
              name,
              "--mode",
              spec.mode,
              "--no-ignore-vcs",
              ...spec.excludes.flatMap((exclude) => ["--ignore", exclude]),
              ...(target.permissions === undefined
                ? []
                : [
                    "--default-owner-beta",
                    `id:${target.permissions.owner}`,
                    "--default-group-beta",
                    `id:${target.permissions.group}`,
                    "--default-file-mode-beta",
                    target.permissions.defaultFileMode,
                    "--default-directory-mode-beta",
                    target.permissions.defaultDirectoryMode,
                  ]),
              spec.source,
              `docker://${target.containerId}${target.path}`,
            ];
            const output = yield* run(args, DEFAULT_TIMEOUT_MS);
            const identifiers = output.match(/sync_[A-Za-z0-9]+/gu) ?? [];
            const identifier = identifiers[0];
            if (identifiers.length !== 1 || identifier === undefined) {
              return yield* Effect.fail(
                startError(
                  "Mutagen created a session but did not return one unambiguous ID; inspect the isolated daemon before retrying.",
                  spec,
                ),
              );
            }
            const owned = { identifier, name, spec, target };
            yield* inspectOwned(owned);
            const committed: SessionReceipt = { ...preparing, phase: "committed", identifier };
            yield* writeLedger(bucket, current, committed, name);
            return owned;
          }),
        );
        // A committed durable session may still hold beta writes or an expensive
        // initial scan. Keep its receipt and history if readiness fails.
        yield* flushOwned(owned);
      }),
    );

  return {
    persistsAcrossProcesses: true,
    invalidateAppDrain,
    drainApp,
    disposeApp,
    completeAppDisposal,
    disposalPhase,
    version: installed.pipe(
      Effect.flatMap(() => run(["version"])),
      Effect.flatMap((output) => {
        const version = output.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
        return version === undefined
          ? Effect.fail(startError("Mutagen returned an unreadable version."))
          : Effect.succeed(version);
      }),
    ),
    create,
    flush: Effect.fn("MutagenProcessClient.flush")(function* (name) {
      const app = yield* withLedger((bucket) =>
        ownedFor(bucket, name).pipe(Effect.map(({ owned }) => owned.spec.app)),
      );
      yield* withAppLock(
        app,
        withLedger((bucket) =>
          ownedFor(bucket, name).pipe(
            Effect.flatMap(({ current, owned }) =>
              sameAppRef(owned.spec.app, app)
                ? directMutationAllowed(current, app).pipe(Effect.as(owned))
                : Effect.fail(startError("Mutagen session ownership changed before flush.")),
            ),
          ),
        ).pipe(Effect.flatMap(flushOwned)),
      );
    }),
    pause: (name) =>
      withNamedApp(name, (app) =>
        withLedger((bucket) =>
          ownedFor(bucket, name).pipe(
            Effect.flatMap(({ current, owned }) =>
              sameAppRef(owned.spec.app, app)
                ? directMutationAllowed(current, app).pipe(Effect.as(owned))
                : Effect.fail(startError("Mutagen session ownership changed before mutation.")),
            ),
            Effect.flatMap((owned) => inspectOwned(owned).pipe(Effect.as(owned))),
            Effect.flatMap((owned) => run(["sync", "pause", owned.identifier])),
            Effect.asVoid,
          ),
        ),
      ).pipe(Effect.mapError((error) => stopError(error.message, name))),
    resume: (name) =>
      withNamedApp(name, (app) =>
        withLedger((bucket) =>
          ownedFor(bucket, name).pipe(
            Effect.flatMap(({ current, owned }) =>
              sameAppRef(owned.spec.app, app)
                ? directMutationAllowed(current, app).pipe(Effect.as(owned))
                : Effect.fail(startError("Mutagen session ownership changed before mutation.")),
            ),
            Effect.flatMap((owned) => inspectOwned(owned).pipe(Effect.as(owned))),
            Effect.flatMap((owned) => run(["sync", "resume", owned.identifier])),
            Effect.asVoid,
          ),
        ),
      ),
    terminate: (name) =>
      Effect.gen(function* () {
        const app = yield* withLedger((bucket) =>
          Effect.gen(function* () {
            const current = yield* readKnownLedger(bucket);
            const receipts = current.sessions.filter((entry) => entry.name === name);
            if (receipts.length === 0) {
              const observed = yield* inspectAll;
              if (observed.some((entry) => entry.name === name))
                return yield* Effect.fail(startError("Mutagen session has no Lando ownership receipt."));
              return undefined;
            }
            if (receipts.length !== 1 || receipts[0] === undefined)
              return yield* Effect.fail(startError("Mutagen session has duplicate ownership receipts."));
            return receipts[0].spec.app;
          }),
        );
        if (app === undefined) return;
        yield* withAppLock(
          app,
          withLedger((bucket) =>
            Effect.gen(function* () {
              const current = yield* readKnownLedger(bucket);
              const receipts = current.sessions.filter((entry) => entry.name === name);
              if (receipts.length === 0) {
                const observed = yield* inspectAll;
                if (observed.some((entry) => entry.name === name))
                  return yield* Effect.fail(startError("Mutagen session has no Lando ownership receipt."));
                return;
              }
              if (receipts.length !== 1)
                return yield* Effect.fail(startError("Mutagen session has duplicate ownership receipts."));
              const { owned } = yield* ownedFor(bucket, name);
              if (!sameAppRef(owned.spec.app, app))
                return yield* Effect.fail(
                  startError("Mutagen session ownership changed before termination."),
                );
              yield* directMutationAllowed(current, app);
              const receipt = receipts[0];
              if (receipt === undefined)
                return yield* Effect.fail(startError("Mutagen ownership receipt disappeared."));
              if (receipt.phase === "disposed") {
                return yield* Effect.fail(startError("Mutagen session is already disposed."));
              }
              const observed = yield* inspectAll;
              const matching = observed.filter((item) => item.identifier === owned.identifier);
              if (matching.length === 1) {
                yield* inspectOwned(owned);
              } else if (matching.length !== 0 || receipt.phase !== "disposing") {
                return yield* Effect.fail(startError("Mutagen session ownership could not be verified."));
              }
              yield* writeLedger(bucket, current, { ...receipt, phase: "disposing" }, name);
              if (matching.length === 1) {
                yield* run(["sync", "terminate", owned.identifier]);
              }
              const after = yield* inspectAll;
              if (after.some((item) => item.identifier === owned.identifier)) {
                return yield* Effect.fail(startError("Mutagen session remained after termination."));
              }
              yield* writeLedger(bucket, current, undefined, name);
            }),
          ),
        );
      }).pipe(Effect.mapError((error) => stopError(error.message, name))),
    list: withLedger((bucket) =>
      readKnownLedger(bucket).pipe(
        Effect.flatMap((value) => reconcilePreparing(bucket, value)),
        Effect.flatMap((current) =>
          inspectAll.pipe(
            Effect.flatMap((listed) => validateInventory(current, listed)),
            Effect.map((live) =>
              live.map(
                ({ receipt, observed }): MutagenSessionRecord => ({
                  name: receipt.name,
                  spec: receipt.spec,
                  status: statusOf(observed),
                  lastUpdatedAt: DateTime.nowUnsafe(),
                  ...((observed.conflicts?.length ?? 0) > 0
                    ? {
                        conflictedPaths: safeConflictPaths(observed.conflicts ?? []),
                        detail: `Mutagen session "${receipt.name}" (${receipt.identifier}) has ${observed.conflicts?.length ?? 0} unresolved synchronization conflict(s). Preserve both versions before resolving them. Inspect session ${receipt.identifier} with the verified Mutagen CLI at "${binary}", isolated session data at "${options.dataDir}", helper "${receipt.target.containerId}", Docker CLI "${options.dockerCliPath}", and Docker config "${dockerConfigDir}".`,
                      }
                    : observed.lastError !== undefined
                      ? {
                          detail: "Mutagen reported a synchronization error; inspect the isolated session.",
                        }
                      : {}),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
    streamEvents: (name) =>
      Stream.fail(startError(`Live Mutagen event streaming is not wired for "${name}".`)),
  };
};
