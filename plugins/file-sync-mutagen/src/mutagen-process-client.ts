import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Context, DateTime, Effect, Schema, Stream } from "effect";

import { FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { FileSyncSessionSpec, type FileSyncSessionStatus } from "@lando/sdk/schema";
import type { ProcessResult, ProcessRunner, StateBucket } from "@lando/sdk/services";

import type { MutagenClient, MutagenSessionRecord } from "./mutagen-client.ts";
import { mutagenHostInstallPath, readInstalledMutagenStatus } from "./provision.ts";

const ENGINE_ID = "mutagen" as const;
const LIST_TEMPLATE = "{{ json . }}";
const IDENTIFIER = /^sync_[A-Za-z0-9]+$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const FLUSH_TIMEOUT_MS = 300_000;
const REMEDIATION =
  "Stop the app and retry; if the session changed outside Lando, inspect Mutagen's isolated session data before removing it.";

type Runner = Pick<Context.Tag.Service<typeof ProcessRunner>, "run">;

interface Endpoint {
  readonly protocol: string;
  readonly host?: string;
  readonly path: string;
  readonly connected?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly scanProblems?: ReadonlyArray<unknown>;
  readonly transitionProblems?: ReadonlyArray<unknown>;
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
  readonly target: { readonly containerId: string; readonly path: string };
}

const SessionReceipt = Schema.Struct({
  phase: Schema.Literal("preparing", "committed", "disposing", "disposed"),
  identifier: Schema.optional(Schema.String),
  name: Schema.String,
  spec: FileSyncSessionSpec,
  target: Schema.Struct({ containerId: Schema.String, path: Schema.String }),
  dataDir: Schema.String,
  dockerHost: Schema.String,
});
type SessionReceipt = Schema.Schema.Type<typeof SessionReceipt>;
const AppDrain = Schema.Struct({
  app: FileSyncSessionSpec.fields.app,
  phase: Schema.Literal("invalidated", "preparing", "drained", "disposing"),
  identifiers: Schema.Array(Schema.String),
});
type AppDrain = Schema.Schema.Type<typeof AppDrain>;
const SessionLedger = Schema.Struct({
  sessions: Schema.Array(SessionReceipt),
  appDrains: Schema.optional(Schema.Array(AppDrain)),
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
          ledger.sessions.some((entry) => app === undefined || isDeepStrictEqual(entry.spec.app, app)),
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
  /** Provider socket, e.g. npipe:////./pipe/podman-lando on Windows. */
  readonly dockerHost: string;
  readonly runner: Runner;
  /** Plugin-scoped durable state and cross-process advisory lock. */
  readonly stateStore: PluginStateStore;
  /** Provider-owned helper container already attached to the target volume. */
  readonly resolveTarget: (spec: FileSyncSessionSpec) => Effect.Effect<
    {
      readonly containerId: string;
      readonly path: string;
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
  platform: string,
  dockerHost: string,
): boolean =>
  observed.name === owned.name &&
  observed.identifier === owned.identifier &&
  observed.alpha.protocol === "local" &&
  pathMatches(owned.spec.source, observed.alpha.path, platform) &&
  observed.beta.protocol === "docker" &&
  observed.beta.host === owned.target.containerId &&
  observed.beta.path === owned.target.path &&
  observed.mode === owned.spec.mode &&
  sameStrings(owned.spec.excludes, observed.ignore?.paths ?? []) &&
  observed.beta.environment?.DOCKER_HOST === dockerHost &&
  observed.beta.environment?.DOCKER_CONTEXT === "";

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

const statusOf = (session: InspectedSession): FileSyncSessionStatus =>
  session.paused ? "paused" : healthy(session) ? "running" : "errored";

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
}

export const makeMutagenProcessClient = (options: MutagenProcessClientOptions): MutagenProcessClient => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binary = mutagenHostInstallPath(options.binDir, platform);

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const env = {
    PATH: [pathApi.dirname(options.dockerCliPath), inheritedPath].filter(Boolean).join(pathApi.delimiter),
    MUTAGEN_DATA_DIRECTORY: options.dataDir,
    MUTAGEN_DOCKER_PATH: pathApi.dirname(options.dockerCliPath),
    DOCKER_HOST: options.dockerHost,
    DOCKER_CONTEXT: "",
  };

  const ledger = openLedger(options.stateStore);
  const withLedger = <A, E>(operation: (bucket: StateBucket<SessionLedger>) => Effect.Effect<A, E>) =>
    options.stateStore
      .withLock("mutagen-sessions", ledger.pipe(Effect.flatMap(operation)))
      .pipe(
        Effect.mapError((error) =>
          error instanceof FileSyncStartError || error instanceof FileSyncStopError
            ? error
            : startError("Could not read or lock Mutagen session ownership state."),
        ),
      );

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

  const run = (args: ReadonlyArray<string>, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    installed.pipe(
      Effect.flatMap(() => options.runner.run({ cmd: binary, args, env, timeoutMs })),
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
          !exactSession(owned, observed, platform, options.dockerHost)
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
      Effect.flatMap(() => inspectOwned(owned)),
      Effect.flatMap((observed) =>
        healthy(observed)
          ? Effect.void
          : Effect.fail(
              startError(
                `Mutagen session "${owned.name}" did not complete a healthy synchronization cycle.`,
                owned.spec,
              ),
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
  const reconcilePreparing = (bucket: StateBucket<SessionLedger>, current: SessionLedger) =>
    Effect.gen(function* () {
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
      const owned = yield* Effect.forEach(committed, receiptOwned);
      if (
        observed.length !== owned.length ||
        owned.some((entry) => {
          const matching = observed.filter((session) => session.identifier === entry.identifier);
          return (
            matching.length !== 1 ||
            matching[0] === undefined ||
            !exactSession(entry, matching[0], platform, options.dockerHost)
          );
        })
      ) {
        return yield* Effect.fail(
          startError(
            "An incomplete Mutagen receipt cannot be cleared because isolated daemon sessions do not match committed ownership.",
          ),
        );
      }
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

  const sameApp = (left: FileSyncSessionSpec["app"], right: FileSyncSessionSpec["app"]) =>
    isDeepStrictEqual(left, right);

  const appReceipts = (current: SessionLedger, app: FileSyncSessionSpec["app"]) =>
    current.sessions.filter((entry) => sameApp(entry.spec.app, app));

  const appDrain = (current: SessionLedger, app: FileSyncSessionSpec["app"]) =>
    current.appDrains?.find((entry) => sameApp(entry.app, app));

  const directMutationAllowed = (
    current: SessionLedger,
    app: FileSyncSessionSpec["app"],
  ): Effect.Effect<void, FileSyncStartError> => {
    const drains = (current.appDrains ?? []).filter((entry) => sameApp(entry.app, app));
    return drains.length <= 1 && (drains.length === 0 || drains[0]?.phase === "invalidated")
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
        ...(current.appDrains ?? []).filter((entry) => !sameApp(entry.app, app)),
        ...(drain === undefined ? [] : [drain]),
      ],
    });

  const validateAppSet = (current: SessionLedger, app: FileSyncSessionSpec["app"]) =>
    Effect.gen(function* () {
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
      if (
        listed.length !== current.sessions.length ||
        current.sessions.some((entry) => {
          const match = listed.filter((item) => item.name === entry.name);
          return match.length !== 1 || match[0]?.identifier !== entry.identifier;
        })
      ) {
        return yield* Effect.fail(
          startError("Mutagen daemon sessions differ from durable ownership receipts."),
        );
      }
      yield* Effect.forEach(owned, inspectOwned);
      return owned;
    });

  const invalidateAppDrain = (app: FileSyncSessionSpec["app"]) =>
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
          (current.appDrains ?? []).filter((entry) => sameApp(entry.app, app)).length > 1 ||
          prior?.phase === "disposing" ||
          prior?.phase === "preparing" ||
          (prior !== undefined && !sameStrings(prior.identifiers, identifiers as string[]))
        ) {
          return yield* Effect.fail(startError("App Mutagen drain state cannot be invalidated."));
        }
        yield* writeAppDrain(
          bucket,
          current,
          { app, phase: "invalidated", identifiers: identifiers as string[] },
          app,
        );
      }),
    );

  const drainApp = (app: FileSyncSessionSpec["app"]) =>
    withLedger((bucket) =>
      Effect.gen(function* () {
        let current = yield* readKnownLedger(bucket);
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
        current = {
          ...current,
          appDrains: [...(current.appDrains ?? []).filter((entry) => !sameApp(entry.app, app)), preparing],
        };
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
          yield* flushOwned(entry);
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
        yield* writeAppDrain(bucket, current, { ...preparing, phase: "drained" }, app);
      }),
    ).pipe(Effect.mapError((error) => stopError(error.message, String(app.id))));

  const disposeApp = (app: FileSyncSessionSpec["app"]) =>
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
              !exactSession(expected, exact, platform, options.dockerHost)
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
        const other = current.sessions.filter((entry) => !sameApp(entry.spec.app, app));
        if (other.some((entry) => entry.phase !== "committed")) {
          return yield* Effect.fail(startError("Another app has incomplete Mutagen session ownership."));
        }
        for (const entry of other) {
          const exact = yield* receiptOwned(entry);
          const matching = listed.filter((item) => item.identifier === exact.identifier);
          if (
            matching.length !== 1 ||
            matching[0] === undefined ||
            !exactSession(exact, matching[0], platform, options.dockerHost)
          ) {
            return yield* Effect.fail(
              startError("Another app Mutagen session no longer matches its ownership receipt."),
            );
          }
        }
        if (
          listed.length !==
          receipts.filter(
            (entry) =>
              entry.phase !== "disposed" && listed.some((item) => item.identifier === entry.identifier),
          ).length +
            other.length
        ) {
          return yield* Effect.fail(startError("Mutagen daemon contains an unowned session."));
        }
        const disposing: AppDrain = { app, phase: "disposing", identifiers };
        yield* writeAppDrain(bucket, current, disposing, app);
        current = {
          ...current,
          appDrains: [...(current.appDrains ?? []).filter((entry) => !sameApp(entry.app, app)), disposing],
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
    ).pipe(Effect.mapError((error) => stopError(error.message, String(app.id))));

  const completeAppDisposal = (app: FileSyncSessionSpec["app"]) =>
    withLedger((bucket) =>
      Effect.gen(function* () {
        const current = yield* readKnownLedger(bucket);
        const receipts = appReceipts(current, app);
        const drain = appDrain(current, app);
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
        const other = current.sessions.filter((entry) => !sameApp(entry.spec.app, app));
        if (listed.length !== other.length) {
          return yield* Effect.fail(startError("Mutagen daemon contains an unowned session."));
        }
        for (const entry of other) {
          const owned = yield* receiptOwned(entry);
          const matches = listed.filter((item) => item.identifier === owned.identifier);
          if (
            matches.length !== 1 ||
            matches[0] === undefined ||
            !exactSession(owned, matches[0], platform, options.dockerHost)
          ) {
            return yield* Effect.fail(startError("Another app Mutagen session changed during disposal."));
          }
        }
        yield* bucket.set({
          ...current,
          sessions: other,
          appDrains: (current.appDrains ?? []).filter((entry) => !sameApp(entry.app, app)),
        });
      }),
    ).pipe(Effect.mapError((error) => stopError(error.message, String(app.id))));

  const create = ({ name, spec }: { readonly name: string; readonly spec: FileSyncSessionSpec }) =>
    withLedger((bucket) =>
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
        const current = yield* reconcilePreparing(bucket, loaded);
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
          if (!isDeepStrictEqual(owned.spec, spec) || !isDeepStrictEqual(owned.target, target)) {
            return yield* Effect.fail(
              startError(`Mutagen session "${name}" differs from its ownership receipt.`, spec),
            );
          }
          yield* flushOwned(owned);
          return;
        }
        const before = yield* inspectAll;
        if (
          before.some(
            (session) =>
              session.name === name ||
              (session.beta.protocol === "docker" &&
                session.beta.host === target.containerId &&
                session.beta.path === target.path) ||
              (session.alpha.protocol === "local" && pathMatches(spec.source, session.alpha.path, platform)),
          )
        ) {
          return yield* Effect.fail(
            startError(
              "A Mutagen session already uses the requested name, source, or helper target; its ownership cannot be proven.",
              spec,
            ),
          );
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
          spec.source,
          `docker://${target.containerId}${target.path}`,
        ];
        const output = yield* run(args, FLUSH_TIMEOUT_MS);
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
        yield* flushOwned(owned).pipe(
          Effect.catchAll((error) =>
            inspectOwned(owned).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  Effect.fail(
                    startError(
                      `Mutagen session ${identifier} did not become ready; cleanup failed because its ownership could not be verified.`,
                      spec,
                    ),
                  ),
                onSuccess: () =>
                  run(["sync", "terminate", identifier]).pipe(
                    Effect.matchEffect({
                      onFailure: () =>
                        Effect.fail(
                          startError(
                            `Mutagen session ${identifier} did not become ready and cleanup failed.`,
                            spec,
                          ),
                        ),
                      onSuccess: () =>
                        writeLedger(bucket, current, undefined, name).pipe(
                          Effect.flatMap(() => Effect.fail(error)),
                        ),
                    }),
                  ),
              }),
            ),
          ),
        );
      }),
    );

  return {
    persistsAcrossProcesses: true,
    invalidateAppDrain,
    drainApp,
    disposeApp,
    completeAppDisposal,
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
    flush: (name) =>
      withLedger((bucket) =>
        ownedFor(bucket, name).pipe(
          Effect.flatMap(({ current, owned }) =>
            directMutationAllowed(current, owned.spec.app).pipe(Effect.flatMap(() => flushOwned(owned))),
          ),
        ),
      ),
    pause: (name) =>
      withLedger((bucket) =>
        ownedFor(bucket, name).pipe(
          Effect.flatMap(({ current, owned }) =>
            directMutationAllowed(current, owned.spec.app).pipe(Effect.as(owned)),
          ),
          Effect.flatMap((owned) => inspectOwned(owned).pipe(Effect.as(owned))),
          Effect.flatMap((owned) => run(["sync", "pause", owned.identifier])),
          Effect.asVoid,
        ),
      ).pipe(Effect.mapError((error) => stopError(error.message, name))),
    resume: (name) =>
      withLedger((bucket) =>
        ownedFor(bucket, name).pipe(
          Effect.flatMap(({ current, owned }) =>
            directMutationAllowed(current, owned.spec.app).pipe(Effect.as(owned)),
          ),
          Effect.flatMap((owned) => inspectOwned(owned).pipe(Effect.as(owned))),
          Effect.flatMap((owned) => run(["sync", "resume", owned.identifier])),
          Effect.asVoid,
        ),
      ),
    terminate: (name) =>
      withLedger((bucket) =>
        Effect.gen(function* () {
          const { current, owned } = yield* ownedFor(bucket, name);
          yield* directMutationAllowed(current, owned.spec.app);
          const receipt = current.sessions.find((entry) => entry.name === name);
          if (receipt === undefined) {
            return yield* Effect.fail(startError("Mutagen ownership receipt disappeared."));
          }
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
      ).pipe(Effect.mapError((error) => stopError(error.message, name))),
    list: withLedger((bucket) =>
      readKnownLedger(bucket).pipe(
        Effect.flatMap((value) => reconcilePreparing(bucket, value)),
        Effect.flatMap((current) =>
          inspectAll.pipe(
            Effect.flatMap((listed) => {
              const names = current.sessions.map((entry) => entry.name);
              if (listed.length !== current.sessions.length || new Set(names).size !== names.length) {
                return Effect.fail(
                  startError(
                    "Mutagen daemon sessions and durable ownership receipts differ; inspect the isolated daemon.",
                  ),
                );
              }
              return Effect.forEach(current.sessions, (entry) =>
                receiptOwned(entry).pipe(
                  Effect.flatMap(inspectOwned),
                  Effect.map(
                    (observed): MutagenSessionRecord => ({
                      name: entry.name,
                      spec: entry.spec,
                      status: statusOf(observed),
                      lastUpdatedAt: DateTime.unsafeNow(),
                      ...(observed.lastError === undefined
                        ? {}
                        : {
                            detail: "Mutagen reported a synchronization error; inspect the isolated session.",
                          }),
                    }),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    ),
    streamEvents: (name) =>
      Stream.fail(startError(`Live Mutagen event streaming is not wired for "${name}".`)),
  };
};
