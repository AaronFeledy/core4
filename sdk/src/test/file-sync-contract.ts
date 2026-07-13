import { DateTime, Effect, Either, Schema, Stream } from "effect";

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "../errors/index.ts";
import {
  AbsolutePath,
  type AppRef,
  FileSyncEngineCapabilities,
  type FileSyncEventChunk,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  type FileSyncSetupOptions,
  ServiceName,
} from "../schema/index.ts";
import type { FileSyncEngineShape, FileSyncError } from "../services/index.ts";
import { ContractFailure, isNonEmptyString, isStream } from "./_shared.ts";
import { CONTRACT_MATRIX_PLATFORMS, type HostPlatformId } from "./provider-contract.ts";

const fileSyncContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `FileSyncEngine contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireFileSyncContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(fileSyncContractFailure(assertion, details));

const FILE_SYNC_CAPABILITY_KEYS = Object.keys(FileSyncEngineCapabilities.fields) as ReadonlyArray<
  keyof typeof FileSyncEngineCapabilities.fields
>;

const FILE_SYNC_TEST_APP_REF: AppRef = {
  kind: "user",
  id: "myapp",
  root: AbsolutePath.make("/srv/apps/myapp"),
};

const FILE_SYNC_TEST_SOURCE = AbsolutePath.make("/srv/apps/myapp");

const buildFileSyncContractSpec = (mountKey: string): FileSyncSessionSpec => ({
  app: FILE_SYNC_TEST_APP_REF,
  service: ServiceName.make("web"),
  mountKey,
  source: FILE_SYNC_TEST_SOURCE,
  target: {
    _tag: "volume" as const,
    name: `lando-sync-${mountKey}`,
    path: "/app" as never,
  },
  mode: "two-way-safe",
  excludes: ["node_modules"],
});

const buildOutsideRootFileSyncContractSpec = (): FileSyncSessionSpec => ({
  ...buildFileSyncContractSpec("outside-root"),
  source: AbsolutePath.make("/etc"),
});

const sourceIsInsideAppRoot = (spec: FileSyncSessionSpec): boolean => {
  const root = spec.app.root;
  return spec.source === root || spec.source.startsWith(`${root}/`);
};

const requireFileSyncTaggedFailure = <A>(
  effect: Effect.Effect<A, FileSyncError>,
  tag: FileSyncError["_tag"],
  assertion: string,
): Effect.Effect<void, ContractFailure> =>
  Effect.either(effect).pipe(
    Effect.flatMap((result) =>
      Either.isLeft(result) && result.left._tag === tag
        ? Effect.void
        : Effect.fail(fileSyncContractFailure(assertion, result)),
    ),
  );

/**
 * Run the `FileSyncEngine` contract assertions. Validates identity,
 * capability decode, lifecycle method types, the create/pause/resume/
 * terminate session round-trip, status reporting through `listSessions`,
 * idempotent pause + terminate, and that the engine surfaces tagged
 * `FileSyncStartError` / `FileSyncDriftError` / `FileSyncStopError` for
 * the documented failure modes.
 */
export const runFileSyncEngineContract = (
  engine: FileSyncEngineShape,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireFileSyncContract(isNonEmptyString(engine.id), "engine exposes a non-empty id", engine.id);
    yield* requireFileSyncContract(
      isNonEmptyString(engine.displayName),
      "engine exposes a non-empty displayName",
      engine.displayName,
    );

    const decodedCapabilities = Schema.decodeUnknownEither(FileSyncEngineCapabilities)(engine.capabilities);
    yield* requireFileSyncContract(Either.isRight(decodedCapabilities), "capabilities decode", {
      capabilities: engine.capabilities,
      decoded: decodedCapabilities,
    });
    for (const key of FILE_SYNC_CAPABILITY_KEYS) {
      yield* requireFileSyncContract(
        (engine.capabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `capability ${String(key)} is populated`,
        engine.capabilities,
      );
    }

    yield* requireFileSyncContract(Effect.isEffect(engine.isAvailable), "isAvailable is Effect-typed");
    yield* requireFileSyncContract(Effect.isEffect(engine.setup({ force: false })), "setup is Effect-typed");
    const sentinelSpec = buildFileSyncContractSpec("__contract__");
    yield* requireFileSyncContract(
      Effect.isEffect(engine.createSession(sentinelSpec)),
      "createSession is Effect-typed",
    );
    const sentinelRef = FileSyncSessionRef.make("__contract__");
    yield* requireFileSyncContract(
      Effect.isEffect(engine.pauseSession(sentinelRef)),
      "pauseSession is Effect-typed",
    );
    yield* requireFileSyncContract(
      Effect.isEffect(engine.resumeSession(sentinelRef)),
      "resumeSession is Effect-typed",
    );
    yield* requireFileSyncContract(
      Effect.isEffect(engine.terminateSession(sentinelRef)),
      "terminateSession is Effect-typed",
    );
    yield* requireFileSyncContract(Effect.isEffect(engine.listSessions({})), "listSessions is Effect-typed");
    yield* requireFileSyncContract(
      isStream(engine.streamEvents(sentinelRef)),
      "streamEvents returns a Stream",
    );

    const isAvailable = yield* engine.isAvailable.pipe(
      Effect.mapError((details: FileSyncError) =>
        fileSyncContractFailure("isAvailable resolves", details as unknown),
      ),
    );
    yield* requireFileSyncContract(
      typeof isAvailable === "boolean",
      "isAvailable resolves to a boolean",
      isAvailable,
    );

    yield* Effect.scoped(engine.setup({ force: false })).pipe(
      Effect.mapError((details: FileSyncError) =>
        fileSyncContractFailure("setup resolves", details as unknown),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const lifecycleSpec = buildFileSyncContractSpec("lifecycle");
        const ref = yield* engine
          .createSession(lifecycleSpec)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("createSession resolves for the contract fixture", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          isNonEmptyString(ref),
          "createSession returns a non-empty FileSyncSessionRef",
          ref,
        );

        const listed = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves", details as unknown),
            ),
          );
        yield* requireFileSyncContract(Array.isArray(listed), "listSessions returns an array", listed);
        yield* requireFileSyncContract(
          listed.find((info: FileSyncSessionInfo) => info.ref === ref)?.status === "running",
          "newly created session reports status = running",
          { listed, ref },
        );

        yield* engine
          .pauseSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("pauseSession resolves", details as unknown),
            ),
          );
        const afterPause = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves after pause", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          afterPause.find((info: FileSyncSessionInfo) => info.ref === ref)?.status === "paused",
          "paused session reports status = paused",
          { listed: afterPause, ref },
        );

        yield* engine
          .pauseSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("pauseSession is idempotent", details as unknown),
            ),
          );

        yield* engine
          .resumeSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("resumeSession resolves", details as unknown),
            ),
          );
        const afterResume = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves after resume", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          afterResume.find((info: FileSyncSessionInfo) => info.ref === ref)?.status === "running",
          "resumed session reports status = running",
          { listed: afterResume, ref },
        );

        yield* engine
          .terminateSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("terminateSession resolves", details as unknown),
            ),
          );
        const afterTerminate = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves after terminate", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          afterTerminate.find((info: FileSyncSessionInfo) => info.ref === ref) === undefined,
          "terminated session is removed from listSessions",
          { listed: afterTerminate, ref },
        );

        yield* engine
          .terminateSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("terminateSession is idempotent", details as unknown),
            ),
          );

        return ref;
      }),
    );

    const scopeFinalizedRef = yield* Effect.scoped(
      engine
        .createSession(buildFileSyncContractSpec("scope-finalizer"))
        .pipe(
          Effect.mapError((details: FileSyncError) =>
            fileSyncContractFailure("createSession registers a scope finalizer", details as unknown),
          ),
        ),
    );
    const afterScope = yield* engine
      .listSessions({})
      .pipe(
        Effect.mapError((details: FileSyncError) =>
          fileSyncContractFailure("listSessions resolves after scope finalization", details as unknown),
        ),
      );
    yield* requireFileSyncContract(
      afterScope.find((info: FileSyncSessionInfo) => info.ref === scopeFinalizedRef) === undefined,
      "session is removed after createSession scope finalizes",
      { listed: afterScope, ref: scopeFinalizedRef },
    );

    yield* requireFileSyncTaggedFailure(
      Effect.scoped(engine.createSession(buildOutsideRootFileSyncContractSpec())),
      "FileSyncStartError",
      "outside-root source fails with FileSyncStartError",
    );
    yield* requireFileSyncTaggedFailure(
      Stream.runCollect(engine.streamEvents(FileSyncSessionRef.make("__CONFLICT__"))),
      "FileSyncDriftError",
      "conflict event stream fails with FileSyncDriftError",
    );
    yield* requireFileSyncTaggedFailure(
      engine.terminateSession(FileSyncSessionRef.make("__STOP_FAIL__")),
      "FileSyncStopError",
      "stop failure fails with FileSyncStopError",
    );
  });

export interface SupportedFileSyncContractCell {
  readonly platform: HostPlatformId;
  readonly supported: true;
  readonly factory: () => Effect.Effect<FileSyncEngineShape, unknown>;
}

export interface UnsupportedFileSyncContractCell {
  readonly platform: HostPlatformId;
  readonly supported: false;
  readonly skipReason: string;
}

export type FileSyncContractMatrixCell = SupportedFileSyncContractCell | UnsupportedFileSyncContractCell;

export interface FileSyncContractMatrixCellResult {
  readonly platform: HostPlatformId;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface FileSyncContractMatrixReport {
  readonly engineName: string;
  readonly results: ReadonlyArray<FileSyncContractMatrixCellResult>;
}

export interface FileSyncContractMatrixOptions {
  readonly engineName: string;
  readonly cells: ReadonlyArray<FileSyncContractMatrixCell>;
}

const isFileSyncSupported = (cell: FileSyncContractMatrixCell): cell is SupportedFileSyncContractCell =>
  cell.supported === true;

const mapFileSyncFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    fileSyncContractFailure(assertion, details);

/**
 * Run the `FileSyncEngine` contract across every canonical host platform
 * cell. Required canonical platforms are `darwin`, `linux`, `win32`, and
 * `wsl` (per `CONTRACT_MATRIX_PLATFORMS`).
 */
export const runFileSyncEngineContractMatrix = (
  options: FileSyncContractMatrixOptions,
): Effect.Effect<FileSyncContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: FileSyncContractMatrixCellResult[] = [];
    const seenPlatforms = new Set<HostPlatformId>();

    for (const cell of options.cells) {
      yield* requireFileSyncContract(
        !seenPlatforms.has(cell.platform),
        "matrix cell platform is unique",
        cell,
      );
      seenPlatforms.add(cell.platform);
    }

    for (const platform of CONTRACT_MATRIX_PLATFORMS) {
      yield* requireFileSyncContract(
        seenPlatforms.has(platform),
        "matrix declares every canonical host platform",
        { engineName: options.engineName, platform },
      );
    }

    for (const cell of options.cells) {
      if (isFileSyncSupported(cell)) {
        yield* requireFileSyncContract(
          typeof cell.factory === "function",
          "supported matrix cell declares a factory",
          cell,
        );
        const engine = yield* cell
          .factory()
          .pipe(Effect.mapError(mapFileSyncFailure(`matrix cell ${cell.platform} factory resolves`)));
        yield* runFileSyncEngineContract(engine);
        results.push({ platform: cell.platform, outcome: "passed" });
      } else {
        yield* requireFileSyncContract(
          isNonEmptyString(cell.skipReason),
          "unsupported matrix cell declares a skip reason",
          cell,
        );
        results.push({ platform: cell.platform, outcome: "skipped", reason: cell.skipReason });
      }
    }

    return { engineName: options.engineName, results };
  });

interface TestFileSyncEngineState {
  readonly sessions: Map<string, FileSyncSessionInfo>;
}

const TEST_FILE_SYNC_STATE = Symbol("TestFileSyncEngineState");

interface TestFileSyncEngineStateCarrier {
  [TEST_FILE_SYNC_STATE]?: TestFileSyncEngineState;
}

const testFileSyncEngineState = (engine: TestFileSyncEngineStateCarrier): TestFileSyncEngineState => {
  let state = engine[TEST_FILE_SYNC_STATE];
  if (state === undefined) {
    Object.defineProperty(engine, TEST_FILE_SYNC_STATE, {
      value: { sessions: new Map() },
      configurable: false,
      enumerable: false,
      writable: false,
    });
    state = engine[TEST_FILE_SYNC_STATE];
  }

  if (state === undefined) {
    throw new Error("failed to initialize test file sync engine state");
  }

  return state;
};

const TEST_FILE_SYNC_CAPABILITIES: FileSyncEngineCapabilities = {
  modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"],
  remoteAgentDeployment: "none",
  exclusionPatterns: true,
  conflictReporting: true,
  progressReporting: true,
};

const sessionRefFor = (spec: FileSyncSessionSpec): FileSyncSessionRef =>
  FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);

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

/**
 * In-memory `FileSyncEngine` reference implementation used by the SDK
 * contract tests. Session lifecycle is fully observable through
 * `listSessions`. Three sentinel inputs trigger the documented tagged
 * error paths so plugin authors can drive the same negative-path
 * coverage:
 *
 * - `createSession({ mountKey: "__REJECT__" })` → `FileSyncStartError`
 * - `streamEvents("__CONFLICT__")` → `FileSyncDriftError`
 * - `terminateSession("__STOP_FAIL__")` → `FileSyncStopError`
 */
export const TestFileSyncEngine: FileSyncEngineShape & TestFileSyncEngineStateCarrier = {
  id: "test",
  displayName: "Test File Sync Engine",
  capabilities: TEST_FILE_SYNC_CAPABILITIES,

  isAvailable: Effect.succeed(true),
  setup: (_options: FileSyncSetupOptions) => Effect.void,

  createSession(this: TestFileSyncEngineStateCarrier, spec: FileSyncSessionSpec) {
    const state = testFileSyncEngineState(this);

    return Effect.gen(function* () {
      if (spec.mountKey === "__REJECT__") {
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId: "test",
            message: "Test rejection sentinel triggered",
            sessionSpec: spec,
          }),
        );
      }
      if (!sourceIsInsideAppRoot(spec)) {
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId: "test",
            message: "Source must resolve inside the app root",
            sessionSpec: spec,
          }),
        );
      }

      const ref = sessionRefFor(spec);
      const info: FileSyncSessionInfo = {
        ref,
        app: spec.app,
        service: spec.service,
        mountKey: spec.mountKey,
        status: "running",
        lastUpdatedAt: DateTime.unsafeMake("2026-05-28T00:00:00Z"),
      };
      state.sessions.set(ref, info);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.sessions.delete(ref);
        }),
      );
      return ref;
    });
  },

  pauseSession(this: TestFileSyncEngineStateCarrier, ref: FileSyncSessionRef) {
    const state = testFileSyncEngineState(this);
    return Effect.sync(() => {
      const current = state.sessions.get(ref);
      if (current === undefined) return;
      state.sessions.set(ref, { ...current, status: "paused" });
    });
  },

  resumeSession(this: TestFileSyncEngineStateCarrier, ref: FileSyncSessionRef) {
    const state = testFileSyncEngineState(this);
    return Effect.sync(() => {
      const current = state.sessions.get(ref);
      if (current === undefined) return;
      state.sessions.set(ref, { ...current, status: "running" });
    });
  },

  terminateSession(this: TestFileSyncEngineStateCarrier, ref: FileSyncSessionRef) {
    const state = testFileSyncEngineState(this);
    if (ref === "__STOP_FAIL__") {
      return Effect.fail(
        new FileSyncStopError({
          engineId: "test",
          sessionRef: ref,
          message: "Test stop-failure sentinel triggered",
        }),
      );
    }

    return Effect.sync(() => {
      state.sessions.delete(ref);
    });
  },

  listSessions(this: TestFileSyncEngineStateCarrier, filter: FileSyncSessionFilter) {
    const state = testFileSyncEngineState(this);
    return Effect.sync(() =>
      Array.from(state.sessions.values()).filter((info) => filterMatches(info, filter)),
    );
  },

  streamEvents: (ref: FileSyncSessionRef): Stream.Stream<FileSyncEventChunk, FileSyncError> => {
    if (ref === "__CONFLICT__") {
      return Stream.fail(
        new FileSyncDriftError({
          engineId: "test",
          message: "Test drift sentinel triggered",
          sessionRef: ref,
          conflictedPaths: ["README.md"],
          suggestedMode: "two-way-resolved",
        }),
      );
    }

    const chunk: FileSyncEventChunk = { _tag: "info", sessionRef: ref, message: "ready" };
    return Stream.make(chunk);
  },
};
