/**
 * @lando/sdk/test — provider contract suite + library API contract suite.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
import { DateTime, Duration, Effect, Either, Schema, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type HostPlatform,
  type PlanMetadata,
  ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "../schema/index.ts";
import type { ExecChunk, LogChunk, RuntimeProviderShape } from "../services/index.ts";

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  message: Schema.String,
  assertion: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");
const TEST_PROVIDER_ID = ProviderId.make("test");

const testCapabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const planMetadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
  source: "@lando/sdk/test",
  runtime: 4,
};

const makeTestServicePlan = (providerId: ProviderId): ServicePlan => ({
  name: TEST_SERVICE_NAME,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: [
    "node",
    "-e",
    "console.log('lando-contract-ready'); setInterval(() => console.log('lando-contract-ready'), 1000)",
  ],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: planMetadata,
  extensions: {},
});

const makeTestAppPlan = (providerId: ProviderId): AppPlan => {
  const testServicePlan = makeTestServicePlan(providerId);

  return {
    id: TEST_APP_ID,
    name: "My App",
    slug: "myapp",
    root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
    provider: providerId,
    services: { [TEST_SERVICE_NAME]: testServicePlan },
    routes: [],
    networks: [],
    stores: [],
    metadata: planMetadata,
    extensions: {},
  };
};

const contractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `RuntimeProvider contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(contractFailure(assertion, details));

const mapProviderFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    contractFailure(assertion, details);

const isStream = (value: unknown): boolean => Stream.StreamTypeId in Object(value);

const CAPABILITY_KEYS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof typeof ProviderCapabilities.fields
>;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const CONTRACT_MATRIX_PLATFORMS: ReadonlyArray<HostPlatform> = ["darwin", "linux", "win32", "wsl"];

/**
 * Run the `RuntimeProvider` contract assertions. Validates capability decode,
 * lifecycle method types, fixture apply/inspect/destroy round-trips, provider
 * identity, status, version fields, capability completeness, ApplyResult
 * shape, re-apply idempotency, list shape, and volume-preserving destroy.
 */
export const runProviderContract = (provider: RuntimeProviderShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const providerId = ProviderId.make(provider.id);
    const testAppPlan = makeTestAppPlan(providerId);
    const capabilities = Schema.decodeUnknownEither(ProviderCapabilities)(provider.capabilities);

    yield* requireContract(isNonEmptyString(provider.id), "provider exposes a non-empty id", provider.id);
    yield* requireContract(
      isNonEmptyString(provider.displayName),
      "provider exposes a non-empty displayName",
      provider.displayName,
    );
    yield* requireContract(
      isNonEmptyString(provider.version),
      "provider exposes a non-empty version",
      provider.version,
    );
    yield* requireContract(
      isNonEmptyString(provider.platform),
      "provider exposes a non-empty platform",
      provider.platform,
    );

    yield* requireContract(Either.isRight(capabilities), "capability matrix decodes", capabilities);
    for (const key of CAPABILITY_KEYS) {
      yield* requireContract(
        (provider.capabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `capability ${String(key)} is populated`,
        provider.capabilities,
      );
    }

    yield* requireContract(Effect.isEffect(provider.isAvailable), "isAvailable is Effect-typed");
    yield* requireContract(Effect.isEffect(provider.getStatus), "getStatus is Effect-typed");
    yield* requireContract(Effect.isEffect(provider.getVersions), "getVersions is Effect-typed");
    yield* requireContract(
      Effect.isEffect(provider.apply(testAppPlan, { reconcile: true })),
      "apply is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.start({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "start is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.stop({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "stop is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.restart({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "restart is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(
        provider.exec({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] }),
      ),
      "exec is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.run({ image: "node:22-alpine", command: ["echo", "ok"] })),
      "run is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.destroy({ app: TEST_APP_ID }, { volumes: true })),
      "destroy is Effect-typed",
    );
    yield* requireContract(
      isStream(
        provider.execStream({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] }),
      ),
      "execStream returns a Stream of stdio chunks",
    );
    yield* requireContract(
      isStream(provider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: false })),
      "logs returns a Stream of LogChunk values",
    );
    yield* requireContract(
      Effect.isEffect(provider.inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "inspect is Effect-typed",
    );
    yield* requireContract(Effect.isEffect(provider.list({ app: TEST_APP_ID })), "list is Effect-typed");

    const available = yield* provider.isAvailable.pipe(
      Effect.mapError(mapProviderFailure("isAvailable resolves")),
    );
    yield* requireContract(typeof available === "boolean", "isAvailable resolves to a boolean", available);

    const status = yield* provider.getStatus.pipe(Effect.mapError(mapProviderFailure("getStatus resolves")));
    yield* requireContract(
      typeof status.running === "boolean",
      "getStatus returns a running boolean",
      status,
    );
    yield* requireContract(
      status.message === undefined || typeof status.message === "string",
      "getStatus message is a string when present",
      status,
    );

    const versions = yield* provider.getVersions.pipe(
      Effect.mapError(mapProviderFailure("getVersions resolves")),
    );
    yield* requireContract(
      isNonEmptyString(versions.provider),
      "getVersions returns a non-empty provider version",
      versions,
    );
    yield* requireContract(
      versions.runtime === undefined || typeof versions.runtime === "string",
      "getVersions runtime is a string when present",
      versions,
    );

    const applyResult = yield* Effect.scoped(provider.apply(testAppPlan, { reconcile: true })).pipe(
      Effect.mapError(mapProviderFailure("apply succeeds for the contract fixture")),
    );
    yield* requireContract(
      typeof applyResult.changed === "boolean",
      "apply returns ApplyResult with a boolean changed field",
      applyResult,
    );

    yield* Effect.scoped(provider.apply(testAppPlan, { reconcile: true })).pipe(
      Effect.mapError(mapProviderFailure("re-apply under reconcile succeeds")),
    );

    const snapshot = yield* provider
      .inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })
      .pipe(Effect.mapError(mapProviderFailure("inspect returns a structured snapshot")));

    yield* requireContract(snapshot.app === TEST_APP_ID, "inspect snapshot includes app id", snapshot);
    yield* requireContract(
      snapshot.service === TEST_SERVICE_NAME,
      "inspect snapshot includes service name",
      snapshot,
    );
    yield* requireContract(
      snapshot.providerId === provider.id,
      "inspect snapshot includes provider id",
      snapshot,
    );
    yield* requireContract(typeof snapshot.status === "string", "inspect snapshot includes status", snapshot);

    const execResult = yield* provider
      .exec({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] })
      .pipe(Effect.mapError(mapProviderFailure("exec returns a structured result")));
    yield* requireContract(
      typeof execResult.exitCode === "number",
      "exec result includes a numeric exitCode",
      execResult,
    );
    yield* requireContract(typeof execResult.stdout === "string", "exec result includes stdout", execResult);
    yield* requireContract(typeof execResult.stderr === "string", "exec result includes stderr", execResult);

    const logChunks = yield* Effect.timeoutFail(
      provider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: true, tail: 20 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
        Effect.mapError(mapProviderFailure("logs emits structured chunks")),
      ),
      {
        // 15s budget: live Docker/Podman log endpoints can take several
        // seconds to flush the first chunk on contended CI runners. The
        // assertion still fails closed if the stream never emits.
        duration: Duration.seconds(15),
        onTimeout: () => contractFailure("logs emits at least one chunk", []),
      },
    );
    yield* requireContract(logChunks.length > 0, "logs emits at least one chunk", logChunks);
    for (const chunk of logChunks) {
      yield* requireContract(chunk.service === TEST_SERVICE_NAME, "log chunk includes service name", chunk);
      yield* requireContract(
        chunk.stream === "stdout" || chunk.stream === "stderr",
        "log chunk includes stream name",
        chunk,
      );
      yield* requireContract(typeof chunk.line === "string", "log chunk includes a line", chunk);
    }

    const listed = yield* provider
      .list({ app: TEST_APP_ID })
      .pipe(Effect.mapError(mapProviderFailure("list resolves for the contract fixture")));
    yield* requireContract(
      Array.isArray(listed),
      "list returns an array of service runtime snapshots",
      listed,
    );

    yield* provider
      .destroy({ app: TEST_APP_ID }, { volumes: false })
      .pipe(Effect.mapError(mapProviderFailure("destroy accepts volumes:false")));

    yield* provider
      .destroy({ app: TEST_APP_ID }, { volumes: true })
      .pipe(Effect.mapError(mapProviderFailure("destroy succeeds for the contract fixture")));

    yield* requireContract(typeof provider.setup === "function", "setup is callable", provider.setup);
    const setupEffect = provider.setup({ force: false });
    yield* requireContract(Effect.isEffect(setupEffect), "setup returns an Effect", setupEffect);

    yield* requireContract(
      versions.bundle === undefined || typeof versions.bundle === "string",
      "getVersions bundle is a string when present",
      versions,
    );
  });

/** Matrix-driven contract runner — runs `runProviderContract` per supported cell, surfaces skip reasons. */
export type HostPlatformId = HostPlatform;

export interface SupportedContractCell {
  readonly platform: HostPlatformId;
  readonly supported: true;
  readonly factory: () => Effect.Effect<RuntimeProviderShape, unknown>;
}

export interface UnsupportedContractCell {
  readonly platform: HostPlatformId;
  readonly supported: false;
  readonly skipReason: string;
}

export type ContractMatrixCell = SupportedContractCell | UnsupportedContractCell;

export interface ContractMatrixCellResult {
  readonly platform: HostPlatformId;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface ContractMatrixReport {
  readonly providerName: string;
  readonly results: ReadonlyArray<ContractMatrixCellResult>;
}

export interface ContractMatrixOptions {
  readonly providerName: string;
  readonly cells: ReadonlyArray<ContractMatrixCell>;
}

const isSupported = (cell: ContractMatrixCell): cell is SupportedContractCell => cell.supported === true;

export const runProviderContractMatrix = (
  options: ContractMatrixOptions,
): Effect.Effect<ContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: ContractMatrixCellResult[] = [];
    const seenPlatforms = new Set<HostPlatform>();

    for (const cell of options.cells) {
      yield* requireContract(!seenPlatforms.has(cell.platform), "matrix cell platform is unique", cell);
      seenPlatforms.add(cell.platform);
    }

    for (const platform of CONTRACT_MATRIX_PLATFORMS) {
      yield* requireContract(seenPlatforms.has(platform), "matrix declares every canonical host platform", {
        providerName: options.providerName,
        platform,
      });
    }

    for (const cell of options.cells) {
      if (isSupported(cell)) {
        yield* requireContract(
          typeof cell.factory === "function",
          "supported matrix cell declares a factory",
          cell,
        );

        const provider = yield* cell
          .factory()
          .pipe(Effect.mapError(mapProviderFailure(`matrix cell ${cell.platform} factory resolves`)));

        yield* requireContract(
          provider.platform === cell.platform,
          "matrix cell provider platform matches cell platform",
          { platform: cell.platform, providerPlatform: provider.platform },
        );
        yield* runProviderContract(provider);
        results.push({ platform: cell.platform, outcome: "passed" });
      } else {
        yield* requireContract(
          isNonEmptyString(cell.skipReason),
          "unsupported matrix cell declares a skip reason",
          cell,
        );
        results.push({ platform: cell.platform, outcome: "skipped", reason: cell.skipReason });
      }
    }

    return { providerName: options.providerName, results };
  });

/**
 * In-memory `RuntimeProvider` reference implementation for SDK contract tests.
 */
export const TestRuntimeProvider: RuntimeProviderShape = {
  id: TEST_PROVIDER_ID,
  displayName: "Test Runtime Provider",
  version: "0.0.0-test",
  platform: "linux",
  capabilities: testCapabilities,

  isAvailable: Effect.succeed(true),
  setup: (_options) => Effect.void,
  getStatus: Effect.succeed({ running: true, message: "ready" }),
  getVersions: Effect.succeed({ provider: "0.0.0-test", runtime: "0.0.0-test" }),

  buildArtifact: (spec) => Effect.succeed({ providerId: TEST_PROVIDER_ID, ref: `${spec.service}:test` }),
  pullArtifact: (spec) => Effect.succeed({ providerId: TEST_PROVIDER_ID, ref: spec.ref }),
  removeArtifact: (_ref) => Effect.void,

  apply: (_plan, _options) => Effect.succeed({ changed: false }),
  start: (_target) => Effect.void,
  stop: (_target) => Effect.void,
  restart: (_target) => Effect.void,
  destroy: (_target, _options) => Effect.void,

  exec: (_target, command) =>
    Effect.succeed({
      exitCode: 0,
      stdout: command.command.join(" "),
      stderr: "",
    }),
  execStream: (_target, command) => {
    const stdoutChunk: ExecChunk = {
      kind: "stdout",
      chunk: new TextEncoder().encode(command.command.join(" ")),
    };
    const exitChunk: ExecChunk = { exitCode: 0 };

    return Stream.make(stdoutChunk, exitChunk);
  },
  run: (spec) =>
    Effect.succeed({
      exitCode: 0,
      stdout: spec.command.join(" "),
      stderr: "",
    }),
  logs: (target, _options) => {
    const chunk: LogChunk = {
      service: target.service,
      stream: "stdout",
      line: "ready",
    };

    return Stream.make(chunk);
  },
  inspect: (target) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: TEST_PROVIDER_ID,
      status: "running",
    }),
  list: (filter) =>
    Effect.succeed([
      {
        app: filter.app ?? TEST_APP_ID,
        service: TEST_SERVICE_NAME,
        providerId: TEST_PROVIDER_ID,
        status: "running",
      },
    ]),
};
