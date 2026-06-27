/**
 * Test helpers for the SDK provider and service contract suites.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  Cause,
  type Context,
  DateTime,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect";

import {
  CapabilityError,
  DataEndpointUnsupportedError,
  DatasetBindingError,
  type ManagedFileError,
  PluginLoadError,
  PluginManifestError,
  RemoteDatasetUnsupportedError,
  RemoteEnvNotFoundError,
  RemoteProtectedEnvError,
  SecretNotFoundError,
  StateStoreError,
  ToolingExecError,
  TunnelTargetUnresolvedError,
} from "../errors/index.ts";

import { emitLandofileYamlEither, parseLandofile } from "../landofile/index.ts";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type CommandSpec,
  type DataEndpoint,
  type DataStoreMountPlan,
  type DatasetContext,
  type DatasetKind,
  type DownloadRequest,
  type DownloadResult,
  type HealthcheckPlan,
  type HostPlatform,
  LandofileShape,
  type ManagedFile,
  type ManagedFileInfo,
  type ManagedFilePlan,
  type ManagedFileResult,
  type PlanMetadata,
  PluginManifest,
  PortablePath,
  type PromptSpec,
  type PromptType,
  ProviderCapabilities,
  ProviderId,
  type RemoteConfig,
  type RemoteEnvId,
  ServiceConfig,
  ServiceName,
  ServicePlan,
  type StorageScope,
  type TunnelSession,
  type TunnelTarget,
  type VolumeInfo,
  type VolumeRef,
} from "../schema/index.ts";
import type {
  CreateRedactorOptions,
  RedactionProfile,
  Redactor,
  TranscriptRedactionEnv,
} from "../secrets/index.ts";
import type {
  DownloaderShape,
  InteractionError,
  InteractionServiceShape,
  ManagedFileService,
  StateBucketSpec,
  StateStoreShape,
} from "../services/index.ts";
import { Renderer } from "../services/index.ts";
import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslatorShape,
  DatasetShape,
  ExecChunk,
  LandoEvent,
  LandofileFragment,
  LogChunk,
  RemoteSourceShape,
  RuntimeProviderShape,
  SecretStoreShape,
  ServiceAppMountIntent,
  ServiceBuildStepIntent,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceMountIntent,
  ServiceType,
  ServiceTypeInput,
  ServiceTypeResolution,
  ToolingEngineResult,
  ToolingInvocation,
  TunnelServiceShape,
} from "../services/index.ts";

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  message: Schema.String,
  assertion: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");
const TEST_PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)("test");
const TEST_COPY_SOURCE = Schema.decodeUnknownSync(AbsolutePath)("/tmp/lando-copy-in.tar");
const TEST_SERVICE_PATH = Schema.decodeUnknownSync(PortablePath)("/app");
const TEST_VOLUME_PATH = Schema.decodeUnknownSync(PortablePath)("/data/payload");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const utf8 = (value: string): Uint8Array => textEncoder.encode(value);

const decodeUtf8 = (value: Uint8Array): string => textDecoder.decode(value);

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const streamBytes = (payload: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield payload;
  },
});

const collectByteStream = <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Uint8Array, E, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => concatBytes(Array.from(chunks))),
  );

const collectStdoutBytes = <E, R>(
  stream: Stream.Stream<ExecChunk, E, R>,
): Effect.Effect<Uint8Array, E | ContractFailure, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.flatMap((chunks) => {
      const collected = Array.from(chunks);
      const exit = collected.find((chunk): chunk is { readonly exitCode: number } => "exitCode" in chunk);
      if (exit !== undefined && exit.exitCode !== 0) {
        return Effect.fail(contractFailure("runStream exits successfully", { exitCode: exit.exitCode }));
      }

      return Effect.succeed(
        concatBytes(
          collected.flatMap((chunk) => ("kind" in chunk && chunk.kind === "stdout" ? [chunk.chunk] : [])),
        ),
      );
    }),
  );

const cloneBytes = (payload: Uint8Array): Uint8Array => new Uint8Array(payload);

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
};

const sampleBytes = (...bytes: ReadonlyArray<number>): Uint8Array => new Uint8Array(bytes);

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
  copyOnWriteAppRoot: false,
  volumeSnapshot: "copy",
  serviceFileCopy: "exec",
  artifactExport: true,
  artifactImport: true,
  ephemeralMounts: true,
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
    fileSync: [],
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

const mapProviderOrContractFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    details instanceof ContractFailure ? details : contractFailure(assertion, details);

const isStream = (value: unknown): boolean => Stream.StreamTypeId in Object(value);

const CAPABILITY_KEYS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof typeof ProviderCapabilities.fields
>;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

type PluginLayerExportName =
  | "ca"
  | "engine"
  | "logger"
  | "provider"
  | "proxy"
  | "renderer"
  | "services"
  | "templateEngine";

export interface PluginContractInput {
  readonly manifest: unknown;
  readonly layers?: Partial<Record<PluginLayerExportName, Layer.Layer<never, unknown, unknown>>>;
  readonly globalServices?: ReadonlyMap<string, Effect.Effect<unknown, unknown, never>>;
  readonly serviceTypes?: ReadonlyMap<string, ServiceType>;
  readonly templateEngines?: ReadonlyMap<string, unknown>;
}

const pluginContributionLayerExports: ReadonlyArray<{
  readonly key: keyof NonNullable<PluginManifest["contributes"]>;
  readonly exportName: PluginLayerExportName;
}> = [
  { key: "cas", exportName: "ca" },
  { key: "fileSyncEngines", exportName: "engine" },
  { key: "loggers", exportName: "logger" },
  { key: "providers", exportName: "provider" },
  { key: "proxies", exportName: "proxy" },
  { key: "renderers", exportName: "renderer" },
  { key: "serviceTypes", exportName: "services" },
  { key: "templateEngines", exportName: "templateEngine" },
];

export const TestPluginManifest: PluginManifest = Schema.decodeSync(PluginManifest)({
  name: "@lando/test-plugin",
  version: "0.0.0",
  api: 4,
  description: "SDK plugin contract fixture.",
  enabled: true,
  contributes: { loggers: ["test"] },
  entry: "./src/index.ts",
  requires: { "@lando/core": "^4.0.0" },
});

const pluginContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `Plugin contract failed: ${assertion}`,
    assertion,
    details,
  });

const requirePluginContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(pluginContractFailure(assertion, details));

const isLayer = (value: unknown): boolean => Layer.isLayer(value);

const hasNonEmptyContributionEntries = (values: ReadonlyArray<unknown> | undefined): boolean =>
  values === undefined ||
  values.every(
    (value) =>
      isNonEmptyString(value) ||
      (typeof value === "object" && value !== null && "id" in value && isNonEmptyString(value.id)),
  );

const contributionId = (value: string | { readonly id: string }): string =>
  typeof value === "string" ? value : value.id;

const REQUIRED_CORE_RANGE = "^4.0.0";

const CORE_COMPATIBILITY_ASSERTION = 'manifest requires "@lando/core" "^4.0.0"';

const CORE_COMPATIBILITY_REMEDIATION = 'Set requires["@lando/core"] to "^4.0.0".';

type CoreRequirementClassification = "compatible" | "missing" | "overly-broad" | "incompatible";

const classifyCoreRequirement = (requires: PluginManifest["requires"]): CoreRequirementClassification => {
  const raw = requires?.["@lando/core"];
  if (typeof raw !== "string" || raw.trim() === "") return "missing";

  const range = raw.trim();
  if (range === REQUIRED_CORE_RANGE) return "compatible";

  if (
    /^[xX*](?:\.[xX*]){0,2}$/.test(range) ||
    range.includes("||") ||
    /^>=\s*(?:0|4(?:\.0(?:\.0)?)?)$/.test(range) ||
    /^>\s*4(?:\.0(?:\.0)?)?$/.test(range)
  ) {
    return "overly-broad";
  }

  return "incompatible";
};

/**
 * runPluginContract arguments:
 * - manifest: decoded or encoded plugin manifest object to validate.
 * - layers: static Layer exports keyed by contribution kind (`provider`, `services`, etc.).
 * - globalServices: static global-service map keyed by contributed service id.
 * - serviceTypes: static service-type map keyed by contributed service type id.
 * - templateEngines: static template-engine map keyed by contributed engine id.
 */
export const runPluginContract = (input: PluginContractInput): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const decodedManifest = Schema.decodeUnknownEither(PluginManifest)(input.manifest, {
      onExcessProperty: "error",
    });

    yield* requirePluginContract(
      Either.isRight(decodedManifest),
      "manifest decodes as PluginManifest",
      decodedManifest,
    );
    if (Either.isLeft(decodedManifest)) return;

    const manifest = decodedManifest.right;

    yield* requirePluginContract(
      isNonEmptyString(manifest.name),
      "manifest name is a non-empty string",
      manifest,
    );
    yield* requirePluginContract(
      isNonEmptyString(manifest.version),
      "manifest version is a non-empty string",
      manifest,
    );
    yield* requirePluginContract(manifest.api === 4, "manifest api is 4", manifest);

    const coreCompatibility = classifyCoreRequirement(manifest.requires);
    yield* requirePluginContract(coreCompatibility === "compatible", CORE_COMPATIBILITY_ASSERTION, {
      reason: coreCompatibility,
      declared: manifest.requires?.["@lando/core"],
      remediation: CORE_COMPATIBILITY_REMEDIATION,
    });

    const contributions = manifest.contributes ?? {};

    for (const [key, values] of Object.entries(contributions)) {
      if (Array.isArray(values) && key !== "globalServices") {
        yield* requirePluginContract(
          hasNonEmptyContributionEntries(values),
          `contribution ${key} contains only non-empty ids`,
          values,
        );
      }
    }

    for (const { key, exportName } of pluginContributionLayerExports) {
      const ids = contributions[key];
      if (!Array.isArray(ids) || ids.length === 0) continue;

      yield* requirePluginContract(
        isLayer(input.layers?.[exportName]),
        `contribution ${key} exposes Layer export ${exportName}`,
        { exportName, ids },
      );
    }

    for (const entry of contributions.globalServices ?? []) {
      yield* requirePluginContract(
        isNonEmptyString(entry.id),
        "globalServices entries have non-empty ids",
        entry,
      );
      yield* requirePluginContract(
        Effect.isEffect(input.globalServices?.get(entry.id)),
        `globalServices static map contains declared id ${entry.id}`,
        entry,
      );
    }

    for (const entry of contributions.serviceTypes ?? []) {
      const id = contributionId(entry);
      yield* requirePluginContract(
        input.serviceTypes?.has(id) === true,
        `serviceTypes static map contains declared id ${id}`,
        { id },
      );
    }

    for (const entry of contributions.templateEngines ?? []) {
      const id = contributionId(entry);
      yield* requirePluginContract(
        input.templateEngines?.has(id) === true,
        `templateEngines static map contains declared id ${id}`,
        { id },
      );
    }

    const loadError = new PluginLoadError({
      message: "plugin contract load error",
      pluginName: manifest.name,
    });
    const manifestError = new PluginManifestError({
      message: "plugin contract manifest error",
      pluginName: manifest.name,
      issues: ["contract"],
    });

    yield* requirePluginContract(
      loadError._tag === "PluginLoadError",
      "PluginLoadError tag is constructible",
      loadError,
    );
    yield* requirePluginContract(
      manifestError._tag === "PluginManifestError",
      "PluginManifestError tag is constructible",
      manifestError,
    );
  });

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
      typeof provider.runStream === "function",
      "runStream is callable",
      provider.runStream,
    );
    yield* requireContract(
      isStream(provider.runStream({ image: "node:22-alpine", command: ["tar", "c"] })),
      "runStream is Stream-typed",
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
    yield* requireContract(
      typeof provider.snapshotVolume === "function",
      "snapshotVolume is callable",
      provider.snapshotVolume,
    );
    yield* requireContract(
      Effect.isEffect(provider.snapshotVolume({ volume: { app: TEST_APP_ID, store: "data" } })),
      "snapshotVolume is Effect-typed",
    );
    yield* requireContract(
      typeof provider.restoreVolume === "function",
      "restoreVolume is callable",
      provider.restoreVolume,
    );
    yield* requireContract(
      Effect.isEffect(
        provider.restoreVolume({
          snapshot: { provider: provider.id, id: "snapshot-1" },
          target: { app: TEST_APP_ID, store: "data" },
        }),
      ),
      "restoreVolume is Effect-typed",
    );
    yield* requireContract(
      typeof provider.listVolumes === "function",
      "listVolumes is callable",
      provider.listVolumes,
    );
    yield* requireContract(
      Effect.isEffect(provider.listVolumes({ app: TEST_APP_ID })),
      "listVolumes is Effect-typed",
    );
    yield* requireContract(
      typeof provider.removeVolume === "function",
      "removeVolume is callable",
      provider.removeVolume,
    );
    yield* requireContract(
      Effect.isEffect(provider.removeVolume({ app: TEST_APP_ID, store: "data" })),
      "removeVolume is Effect-typed",
    );
    yield* requireContract(
      typeof provider.copyToService === "function",
      "copyToService is callable",
      provider.copyToService,
    );
    yield* requireContract(
      Effect.isEffect(
        provider.copyToService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_COPY_SOURCE, targetPath: TEST_SERVICE_PATH },
        ),
      ),
      "copyToService is Effect-typed",
    );
    yield* requireContract(
      typeof provider.copyFromService === "function",
      "copyFromService is callable",
      provider.copyFromService,
    );
    yield* requireContract(
      isStream(
        provider.copyFromService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_SERVICE_PATH },
        ),
      ),
      "copyFromService is Stream-typed",
    );
    yield* requireContract(
      typeof provider.exportArtifact === "function",
      "exportArtifact is callable",
      provider.exportArtifact,
    );
    yield* requireContract(
      isStream(provider.exportArtifact({ providerId, ref: "web:test" })),
      "exportArtifact is Stream-typed",
    );
    yield* requireContract(
      typeof provider.importArtifact === "function",
      "importArtifact is callable",
      provider.importArtifact,
    );
    yield* requireContract(
      Effect.isEffect(provider.importArtifact(Stream.make(new Uint8Array([1, 2, 3])))),
      "importArtifact is Effect-typed",
    );

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
        // Live provider log endpoints can take several seconds to flush the
        // first chunk on contended CI runners; still fail closed if no chunk emits.
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

export interface ProviderDataPlaneContractInput {
  readonly providerName?: string;
  readonly factory: () => Effect.Effect<RuntimeProviderShape, unknown>;
}

const endpointKind = (endpoint: DataEndpoint): string => endpoint._tag;

const unsupportedDataPlanePair = (
  from: DataEndpoint,
  to: DataEndpoint,
): Effect.Effect<never, DataEndpointUnsupportedError> =>
  Effect.fail(
    new DataEndpointUnsupportedError({
      message: `Cannot transfer ${endpointKind(from)} to ${endpointKind(to)} with the provider data-plane contract fixture.`,
      fromEndpoint: endpointKind(from),
      toEndpoint: endpointKind(to),
      remediation: "Use DataMover with a supported endpoint pair or provide a matching native capability.",
    }),
  );

const requireGenericVolumeFallback = (
  provider: RuntimeProviderShape,
): Effect.Effect<void, CapabilityError> =>
  provider.capabilities.ephemeralMounts
    ? Effect.void
    : Effect.fail(
        new CapabilityError({
          message: "Provider data-plane contract requires ephemeral mounts.",
          feature: "provider data-plane contract",
          capability: "ephemeralMounts",
          providerId: provider.id,
          remediation: "Implement EphemeralRunSpec.mounts before running the shared data-plane contract.",
        }),
      );

const nextContractRunId = (): string => {
  return `contract-data-${randomUUID()}`;
};

const dataStoreMount = (store: string): DataStoreMountPlan => ({
  store,
  target: Schema.decodeUnknownSync(PortablePath)("/data"),
  readOnly: false,
});

const writeMountedVolume = (
  provider: RuntimeProviderShape,
  store: string,
  payload: Uint8Array,
): Effect.Effect<void, unknown | ContractFailure, Scope.Scope> =>
  provider
    .run({
      image: "alpine:3.20",
      command: ["sh", "-c", "cat > /data/payload"],
      mounts: [dataStoreMount(store)],
      stdinStream: streamBytes(payload),
      remove: true,
    })
    .pipe(
      Effect.flatMap((result) =>
        requireContract(
          result.exitCode === 0,
          "volume import via EphemeralRunSpec.stdinStream exits successfully",
          {
            exitCode: result.exitCode,
          },
        ),
      ),
    );

const readMountedVolume = (
  provider: RuntimeProviderShape,
  store: string,
): Effect.Effect<Uint8Array, unknown | ContractFailure, Scope.Scope> =>
  collectStdoutBytes(
    provider.runStream({
      image: "alpine:3.20",
      command: ["sh", "-c", "cat /data/payload"],
      mounts: [dataStoreMount(store)],
      captureStdout: true,
      remove: true,
    }),
  );

const withTempCopySource = <A, E, R>(
  payload: Uint8Array,
  use: (path: AbsolutePath) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "lando-provider-contract-"));
      const path = join(directory, "payload.bin");
      await writeFile(path, payload);
      return { directory, path: Schema.decodeUnknownSync(AbsolutePath)(path) };
    }),
    ({ path }) => use(path),
    ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

export const runProviderDataPlaneContract = (
  input: ProviderDataPlaneContractInput,
): Effect.Effect<void, ContractFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const provider = yield* input
        .factory()
        .pipe(
          Effect.mapError(
            mapProviderFailure(`${input.providerName ?? "provider"} data-plane factory resolves`),
          ),
        );
      const store = nextContractRunId();
      const volumePayload = sampleBytes(0, 1, 2, 3, 128, 255);
      const mutatedPayload = sampleBytes(255, 128, 3, 2, 1, 0);
      const servicePayload = sampleBytes(9, 8, 7, 6, 5, 4);
      const artifactPayload = sampleBytes(4, 5, 6, 7, 8, 9);

      yield* requireContract(
        provider.capabilities.volumeSnapshot !== "none",
        "data-plane provider declares volume snapshot support",
        provider.capabilities,
      );
      yield* requireContract(
        provider.capabilities.serviceFileCopy !== "none",
        "data-plane provider declares service file copy support",
        provider.capabilities,
      );
      yield* requireContract(
        provider.capabilities.artifactExport,
        "data-plane provider declares artifact export support",
        provider.capabilities,
      );
      yield* requireContract(
        provider.capabilities.artifactImport,
        "data-plane provider declares artifact import support",
        provider.capabilities,
      );

      const unsupportedExit = yield* Effect.exit(
        unsupportedDataPlanePair(
          { _tag: "artifact", ref: "web:test" },
          {
            _tag: "servicePath",
            app: TEST_APP_ID,
            service: TEST_SERVICE_NAME,
            path: TEST_VOLUME_PATH,
          },
        ),
      );
      yield* requireContract(
        unsupportedExit._tag === "Failure" &&
          unsupportedExit.cause._tag === "Fail" &&
          unsupportedExit.cause.error instanceof DataEndpointUnsupportedError,
        "unrealizable transfer fails DataEndpointUnsupportedError",
        unsupportedExit,
      );

      yield* requireGenericVolumeFallback(provider).pipe(
        Effect.mapError((error) =>
          contractFailure("data-plane contract without ephemeral mounts fails CapabilityError", error),
        ),
      );

      yield* writeMountedVolume(provider, store, volumePayload).pipe(
        Effect.mapError(
          mapProviderOrContractFailure("volume import via EphemeralRunSpec.stdinStream succeeds"),
        ),
      );
      const exportedVolume = yield* readMountedVolume(provider, store).pipe(
        Effect.mapError(mapProviderFailure("volume export via runStream succeeds")),
      );
      yield* requireContract(
        bytesEqual(exportedVolume, volumePayload),
        "importVolume(exportVolume(x)) == x",
        { expected: Array.from(volumePayload), actual: Array.from(exportedVolume) },
      );

      const snapshot = yield* provider
        .snapshotVolume({ volume: { app: TEST_APP_ID, store } })
        .pipe(Effect.mapError(mapProviderFailure("snapshotVolume succeeds")));
      yield* writeMountedVolume(provider, store, mutatedPayload).pipe(
        Effect.mapError(
          mapProviderOrContractFailure("volume mutation via EphemeralRunSpec.stdinStream succeeds"),
        ),
      );
      yield* provider
        .restoreVolume({
          snapshot,
          target: { app: TEST_APP_ID, store },
          overwrite: true,
        })
        .pipe(Effect.mapError(mapProviderFailure("restoreVolume succeeds")));
      const restoredVolume = yield* readMountedVolume(provider, store).pipe(
        Effect.mapError(mapProviderFailure("restored volume export via runStream succeeds")),
      );
      yield* requireContract(
        bytesEqual(restoredVolume, volumePayload),
        "snapshot -> mutate -> restore restores volume bytes",
        { expected: Array.from(volumePayload), actual: Array.from(restoredVolume) },
      );

      yield* withTempCopySource(servicePayload, (sourcePath) =>
        provider.copyToService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath, targetPath: TEST_VOLUME_PATH, overwrite: true },
        ),
      ).pipe(Effect.mapError(mapProviderFailure("copyToService succeeds")));
      const copiedServiceBytes = yield* collectByteStream(
        provider.copyFromService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_VOLUME_PATH },
        ),
      ).pipe(Effect.mapError(mapProviderFailure("copyFromService succeeds")));
      yield* requireContract(
        bytesEqual(copiedServiceBytes, servicePayload),
        "copyToService/copyFromService round-trips bytes",
        { expected: Array.from(servicePayload), actual: Array.from(copiedServiceBytes) },
      );

      const importedArtifact = yield* provider
        .importArtifact(Stream.make(artifactPayload))
        .pipe(Effect.mapError(mapProviderFailure("importArtifact succeeds")));
      const exportedArtifact = yield* collectByteStream(provider.exportArtifact(importedArtifact)).pipe(
        Effect.mapError(mapProviderFailure("exportArtifact succeeds")),
      );
      yield* requireContract(
        bytesEqual(exportedArtifact, artifactPayload),
        "artifact export/import round-trips bytes",
        { expected: Array.from(artifactPayload), actual: Array.from(exportedArtifact) },
      );
    }),
  );

const testVolumeBytes = new Map<string, Uint8Array>();
const testSnapshotBytes = new Map<string, Uint8Array>();
const testServicePathBytes = new Map<string, Uint8Array>();
const testArtifactBytes = new Map<string, Uint8Array>();
let testArtifactImportCount = 0;

const volumeKey = (ref: {
  readonly app: AppId;
  readonly store: string;
  readonly scope?: string | undefined;
}): string => `${ref.app}:${ref.store}:${ref.scope ?? "app"}`;

const servicePathKey = (
  target: { readonly app: AppId; readonly service: ServiceName },
  path: PortablePath,
): string => `${target.app}:${target.service}:${path}`;

const firstDataStoreMount = (
  mounts: Parameters<RuntimeProviderShape["run"]>[0]["mounts"],
): DataStoreMountPlan | undefined =>
  Array.isArray(mounts) ? mounts.find((mount): mount is DataStoreMountPlan => "store" in mount) : undefined;

const storageScopeFromKey = (scope: string | undefined): StorageScope | undefined =>
  scope === "service" || scope === "app" || scope === "global" ? scope : undefined;

const volumeRef = (app: AppId, store: string, scope?: StorageScope | undefined): VolumeRef =>
  scope === undefined ? { app, store } : { app, store, scope };

const volumeInfo = (ref: VolumeRef, labels?: Readonly<Record<string, string>> | undefined): VolumeInfo =>
  labels === undefined ? { ref } : { ref, labels };

const collectAsyncBytes = (input: AsyncIterable<Uint8Array> | undefined): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const chunks: Uint8Array[] = [];
    if (input === undefined) return concatBytes(chunks);
    for await (const chunk of input) chunks.push(chunk);
    return concatBytes(chunks);
  });

const mountedVolumeKeyForSpec = (spec: Parameters<RuntimeProviderShape["run"]>[0]): string | undefined => {
  const mount = firstDataStoreMount(spec.mounts);
  return mount === undefined ? undefined : volumeKey({ app: TEST_APP_ID, store: mount.store });
};

const runTestEphemeral = (spec: Parameters<RuntimeProviderShape["run"]>[0]) =>
  Effect.gen(function* () {
    const command = spec.command.join(" ");
    const mountedVolumeKey = mountedVolumeKeyForSpec(spec);

    if (mountedVolumeKey !== undefined && command === "sh -c cat > /data/payload") {
      const payload = yield* collectAsyncBytes(spec.stdinStream);
      testVolumeBytes.set(mountedVolumeKey, cloneBytes(payload));
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (mountedVolumeKey !== undefined && command === "sh -c cat /data/payload") {
      return {
        exitCode: 0,
        stdout: decodeUtf8(testVolumeBytes.get(mountedVolumeKey) ?? utf8("")),
        stderr: "",
      };
    }

    return {
      exitCode: 0,
      stdout: spec.command.join(" "),
      stderr: "",
    };
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
  run: (spec) => runTestEphemeral(spec),
  runStream: (spec) => {
    const command = spec.command.join(" ");
    const mountedVolumeKey = mountedVolumeKeyForSpec(spec);
    if (mountedVolumeKey !== undefined && command === "sh -c cat /data/payload") {
      const stdoutChunk: ExecChunk = {
        kind: "stdout",
        chunk: cloneBytes(testVolumeBytes.get(mountedVolumeKey) ?? utf8("")),
      };
      const exitChunk: ExecChunk = { exitCode: 0 };

      return Stream.make(stdoutChunk, exitChunk);
    }

    return Stream.unwrap(
      runTestEphemeral(spec).pipe(
        Effect.map((result) => {
          const stdoutChunk: ExecChunk = {
            kind: "stdout",
            chunk: utf8(result.stdout),
          };
          const exitChunk: ExecChunk = { exitCode: result.exitCode };

          return Stream.make(stdoutChunk, exitChunk);
        }),
      ),
    );
  },
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
  snapshotVolume: (spec) =>
    Effect.sync(() => {
      const id = spec.snapshotId ?? `${spec.volume.store}-snapshot`;
      testSnapshotBytes.set(id, cloneBytes(testVolumeBytes.get(volumeKey(spec.volume)) ?? utf8("")));
      return { provider: TEST_PROVIDER_ID, id };
    }),
  restoreVolume: (spec) =>
    Effect.sync(() => {
      testVolumeBytes.set(
        volumeKey(spec.target),
        cloneBytes(testSnapshotBytes.get(spec.snapshot.id) ?? utf8("")),
      );
    }),
  listVolumes: (filter) =>
    Effect.sync(() => {
      const volumes = Array.from(testVolumeBytes.keys()).map((key) => {
        const [app, store, scope] = key.split(":");
        return volumeInfo(
          volumeRef(AppId.make(app ?? String(TEST_APP_ID)), store ?? "data", storageScopeFromKey(scope)),
          filter.labels,
        );
      });
      return volumes.length > 0
        ? volumes
        : [
            volumeInfo(
              volumeRef(filter.app ?? TEST_APP_ID, filter.store ?? "data", filter.scope),
              filter.labels,
            ),
          ];
    }),
  removeVolume: (ref) =>
    Effect.sync(() => {
      testVolumeBytes.delete(volumeKey(ref));
    }),
  copyToService: (target, spec) =>
    Effect.promise(async () => {
      const payload = await readFile(spec.sourcePath);
      testServicePathBytes.set(servicePathKey(target, spec.targetPath), cloneBytes(payload));
    }),
  copyFromService: (target, spec) =>
    Stream.make(cloneBytes(testServicePathBytes.get(servicePathKey(target, spec.sourcePath)) ?? utf8(""))),
  exportArtifact: (ref) => Stream.make(cloneBytes(testArtifactBytes.get(ref.ref) ?? utf8(ref.ref))),
  importArtifact: (data) =>
    Effect.gen(function* () {
      const payload = yield* collectByteStream(data);
      testArtifactImportCount += 1;
      const ref = `imported:${testArtifactImportCount}`;
      testArtifactBytes.set(ref, cloneBytes(payload));
      return { providerId: TEST_PROVIDER_ID, ref };
    }),
};

/**
 * Reference `ServiceType` the SDK ships for in-suite composition contract
 * tests. It declares a base and resolves to a normalized config + feature list
 * composition contract; it never hand-builds a `ServicePlan`.
 */
export const TestServiceType: ServiceType = {
  id: "test",
  name: "test",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input: ServiceTypeInput) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: input.service,
      features: [],
    } satisfies ServiceTypeResolution),
};

const serviceCompositionFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceType composition contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceComposition = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceCompositionFailure(assertion, details));

/** Input the composition contract feeds into {@link ServiceType.resolve}. */
export interface ServiceCompositionContractInput {
  readonly serviceType: ServiceType;
  /** Landofile service block whose decoded config is resolved. */
  readonly landofileService: Record<string, unknown>;
  readonly serviceName?: string;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly providerId?: ProviderId;
}

/**
 * Run the service-composition contract: the type exposes a non-empty id/name,
 * declares a `base` of `"l337"` or `"lando"`, and `resolve()` is an Effect that
 * yields a `ServiceTypeResolution` with decoded `normalizedConfig` and a stable
 * (replay-equal) `features` array — and never returns a `ServicePlan`.
 */
export const runServiceCompositionContract = (
  input: ServiceCompositionContractInput,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const serviceType = input.serviceType;
    const serviceName = input.serviceName ?? "web";
    const appName = input.appName ?? "myapp";
    const appRoot = input.appRoot ?? `/srv/apps/${appName}`;

    yield* requireServiceComposition(
      isNonEmptyString(serviceType.id),
      "service type exposes a non-empty id",
      serviceType.id,
    );
    yield* requireServiceComposition(
      isNonEmptyString(serviceType.name),
      "service type exposes a non-empty name",
      serviceType.name,
    );
    yield* requireServiceComposition(
      serviceType.base === "l337" || serviceType.base === "lando",
      "service type declares a base of l337 or lando",
      serviceType.base,
    );
    yield* requireServiceComposition(
      typeof serviceType.resolve === "function",
      "service type resolve is callable",
      typeof serviceType.resolve,
    );

    const decodedLandofile = Schema.decodeUnknownEither(LandofileShape)({
      name: appName,
      services: { [serviceName]: input.landofileService },
    });
    yield* requireServiceComposition(
      Either.isRight(decodedLandofile),
      "landofile service input decodes through LandofileShape",
      Either.isLeft(decodedLandofile) ? decodedLandofile.left : undefined,
    );
    if (Either.isLeft(decodedLandofile)) return;

    const decodedService = decodedLandofile.right.services?.[ServiceName.make(serviceName)];
    yield* requireServiceComposition(
      decodedService !== undefined,
      "landofile decode preserves the requested service entry",
      { serviceName },
    );
    if (decodedService === undefined) return;

    const makeInput = (): ServiceTypeInput => ({
      name: serviceName,
      service: decodedService,
      appRoot,
      appName,
      ...(input.providerId === undefined ? {} : { provider: input.providerId }),
      primary: false,
      metadata: {
        resolvedAt: "2026-05-10T18:51:00Z",
        source: "@lando/sdk/test/service-composition-contract",
        runtime: 4,
      },
    });

    const resolution = yield* serviceType
      .resolve(makeInput())
      .pipe(
        Effect.mapError((cause) => serviceCompositionFailure("service type resolve succeeds", String(cause))),
      );

    yield* requireServiceComposition(
      typeof resolution === "object" && resolution !== null,
      "resolve returns a ServiceTypeResolution object",
      resolution,
    );
    yield* requireServiceComposition(
      !Schema.is(ServicePlan)(resolution as unknown),
      "resolve returns a resolution, not a hand-built ServicePlan",
      { keys: Object.keys(resolution as unknown as Record<string, unknown>) },
    );
    yield* requireServiceComposition(
      resolution.base === serviceType.base,
      "resolution base matches the declared service type base",
      { declared: serviceType.base, resolved: resolution.base },
    );

    const normalizedDecodes = Schema.is(ServiceConfig)(resolution.normalizedConfig);
    yield* requireServiceComposition(
      normalizedDecodes,
      "resolution normalizedConfig is a valid ServiceConfig",
      resolution.normalizedConfig,
    );

    yield* requireServiceComposition(
      Array.isArray(resolution.features),
      "resolution features is an array of FeatureRefs",
      resolution.features,
    );
    for (const [index, feature] of resolution.features.entries()) {
      yield* requireServiceComposition(
        isNonEmptyString(feature.id),
        "resolution feature declares a non-empty id",
        { index, feature },
      );
    }

    const second = yield* serviceType
      .resolve(makeInput())
      .pipe(
        Effect.mapError((cause) =>
          serviceCompositionFailure("service type resolve is replay-safe", String(cause)),
        ),
      );
    yield* requireServiceComposition(
      second.base === resolution.base &&
        stableJson(second.normalizedConfig) === stableJson(resolution.normalizedConfig),
      "resolution base + normalizedConfig stable across replays",
      {
        first: { base: resolution.base, normalizedConfig: resolution.normalizedConfig },
        second: { base: second.base, normalizedConfig: second.normalizedConfig },
      },
    );
    yield* requireServiceComposition(
      second.features.length === resolution.features.length &&
        second.features.every((feature, index) => feature.id === resolution.features[index]?.id),
      "resolution feature list is stable across replays",
      { first: resolution.features, second: second.features },
    );
  });

const serviceFeatureFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceFeature contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceFeature = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceFeatureFailure(assertion, details));

const providerCapabilityReads = new Set(["capabilities", "provider", "providerId"]);

const hasRealizationDecision = (intent: unknown): boolean =>
  typeof intent === "object" && intent !== null && "realization" in intent;

const stableUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableUnknown);
  if (value instanceof Map) {
    return Array.from(value.entries())
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => [key, stableUnknown(entry)]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableUnknown(entry)]),
    );
  }
  return value;
};

const stableJson = (value: unknown): string => JSON.stringify(stableUnknown(value));

const recordingServiceFeatureDraft = (
  recorded: ReturnType<typeof makeRecordingServiceFeatureContext>["recorded"],
) => ({
  env: Array.from(recorded.env.entries()).sort(([left], [right]) => left.localeCompare(right)),
  mounts: stableUnknown(recorded.mounts),
  appMounts: stableUnknown(recorded.appMounts),
  buildSteps: stableUnknown(recorded.buildSteps),
  extensions: Array.from(recorded.extensions.entries()).sort(([left], [right]) => left.localeCompare(right)),
  storage: stableUnknown(recorded.storage),
  endpoints: stableUnknown(recorded.endpoints),
  dependencies: stableUnknown(recorded.dependencies),
  hostAliases: stableUnknown(recorded.hostAliases),
  settings: stableUnknown(recorded.settings),
});

/** Input the feature contract uses to execute a single service feature. */
export interface ServiceFeatureContractHarness {
  readonly feature: ServiceFeatureDefinition;
  readonly serviceName?: string;
  readonly serviceType?: string;
  readonly base?: "l337" | "lando";
  readonly primary?: boolean;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly normalizedConfig?: ServiceConfig;
  readonly config?: Readonly<Record<string, unknown>>;
}

const makeRecordingServiceFeatureContext = (input: ServiceFeatureContractHarness) => {
  const recorded = {
    env: new Map<string, string>(),
    mounts: [] as ServiceMountIntent[],
    appMounts: [] as ServiceAppMountIntent[],
    buildSteps: [] as ServiceBuildStepIntent[],
    extensions: new Map<string, unknown>(),
    storage: [] as unknown[],
    endpoints: [] as unknown[],
    dependencies: [] as unknown[],
    hostAliases: [] as unknown[],
    settings: {} as Record<string, unknown>,
    forbiddenReads: new Set<string>(),
  };

  const context: ServiceFeatureContext = {
    serviceName: input.serviceName ?? "web",
    serviceType: input.serviceType ?? "test",
    base: input.base ?? "lando",
    primary: input.primary ?? false,
    ...(input.appName === undefined ? {} : { appName: input.appName }),
    appRoot: input.appRoot ?? "/srv/apps/myapp",
    normalizedConfig: input.normalizedConfig ?? { type: "test" },
    config: input.config ?? {},
    addEnv(name, value) {
      recorded.env.set(name, value);
    },
    addMount(mount) {
      recorded.mounts.push(mount);
    },
    setAppMount(mount) {
      recorded.appMounts.push(mount);
    },
    addBuildStep(step) {
      recorded.buildSteps.push(step);
    },
    addExtension(key, value) {
      recorded.extensions.set(key, value);
    },
    addStorage(storage) {
      recorded.storage.push(storage);
    },
    addEndpoint(endpoint) {
      recorded.endpoints.push(endpoint);
    },
    addDependency(dependency) {
      recorded.dependencies.push(dependency);
    },
    addHostAlias(alias) {
      recorded.hostAliases.push(alias);
    },
    setHealthcheck(healthcheck) {
      recorded.settings.healthcheck = healthcheck;
    },
    setCerts(certs) {
      recorded.settings.certs = certs;
    },
    setEntrypoint(entrypoint) {
      recorded.settings.entrypoint = entrypoint;
    },
    setCommand(command) {
      recorded.settings.command = command;
    },
    setArtifact(artifact) {
      recorded.settings.artifact = artifact;
    },
    setUser(user) {
      recorded.settings.user = user;
    },
    setWorkingDirectory(path) {
      recorded.settings.workingDirectory = path;
    },
  };

  const proxiedContext = new Proxy(context, {
    get(target, property, receiver) {
      if (typeof property === "string" && providerCapabilityReads.has(property)) {
        recorded.forbiddenReads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === "string" && providerCapabilityReads.has(property)) {
        recorded.forbiddenReads.add(property);
      }
      return Reflect.has(target, property);
    },
  });

  return { context: proxiedContext, recorded };
};

/**
 * Run the service-feature contract: a feature exposes a stable id/priority/apply
 * hook, its `apply` succeeds against the published provider-neutral context, it
 * does not inspect provider capabilities, and its emitted mount/app-mount intent
 * never includes a realization decision.
 */
export const runServiceFeatureContract = (
  input: ServiceFeatureContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const feature = input.feature;

    yield* requireServiceFeature(
      isNonEmptyString(feature.id),
      "service feature exposes a non-empty id",
      feature.id,
    );
    yield* requireServiceFeature(
      Number.isFinite(feature.priority),
      "service feature exposes a finite priority",
      feature.priority,
    );
    yield* requireServiceFeature(
      typeof feature.apply === "function",
      "service feature apply is callable",
      typeof feature.apply,
    );
    yield* requireServiceFeature(
      feature.requires === undefined ||
        (Array.isArray(feature.requires) && feature.requires.every(isNonEmptyString)),
      "service feature requires is an array of non-empty capability strings",
      feature.requires,
    );

    const { context, recorded } = makeRecordingServiceFeatureContext(input);
    const applyEffect = yield* Effect.try({
      try: () => feature.apply(context),
      catch: (cause) => serviceFeatureFailure("feature apply succeeds", String(cause)),
    });
    const applyExit = yield* Effect.exit(applyEffect);
    if (Exit.isFailure(applyExit)) {
      yield* Effect.fail(serviceFeatureFailure("feature apply succeeds", Cause.pretty(applyExit.cause)));
      return;
    }

    yield* requireServiceFeature(
      recorded.forbiddenReads.size === 0,
      "feature does not inspect provider capabilities",
      Array.from(recorded.forbiddenReads),
    );

    const mountWithRealization = recorded.mounts.find(hasRealizationDecision);
    yield* requireServiceFeature(
      mountWithRealization === undefined,
      "feature emits mount intent without realization decisions",
      mountWithRealization,
    );

    const appMountWithRealization = recorded.appMounts.find(hasRealizationDecision);
    yield* requireServiceFeature(
      appMountWithRealization === undefined,
      "feature emits app mount intent without realization decisions",
      appMountWithRealization,
    );

    const storageWithRealization = recorded.storage.find(hasRealizationDecision);
    yield* requireServiceFeature(
      storageWithRealization === undefined,
      "feature emits storage intent without realization decisions",
      storageWithRealization,
    );

    const endpointWithRealization = recorded.endpoints.find(hasRealizationDecision);
    yield* requireServiceFeature(
      endpointWithRealization === undefined,
      "feature emits endpoint intent without realization decisions",
      endpointWithRealization,
    );

    const second = makeRecordingServiceFeatureContext(input);
    const secondApplyEffect = yield* Effect.try({
      try: () => feature.apply(second.context),
      catch: (cause) => serviceFeatureFailure("feature apply succeeds", String(cause)),
    });
    const secondApplyExit = yield* Effect.exit(secondApplyEffect);
    if (Exit.isFailure(secondApplyExit)) {
      yield* Effect.fail(
        serviceFeatureFailure("feature apply succeeds", Cause.pretty(secondApplyExit.cause)),
      );
      return;
    }

    const firstDraft = recordingServiceFeatureDraft(recorded);
    const secondDraft = recordingServiceFeatureDraft(second.recorded);
    yield* requireServiceFeature(
      stableJson(firstDraft) === stableJson(secondDraft),
      "service feature apply is deterministic/idempotent",
      { first: firstDraft, second: secondDraft },
    );
  });

const appFeatureFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `AppFeature contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireAppFeature = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(appFeatureFailure(assertion, details));

/** A resolved service draft the app-feature contract evaluates selectors against. */
export interface AppFeatureContractService {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly base?: "l337" | "lando";
  readonly framework?: string;
  readonly primary?: boolean;
  readonly featureIds?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
}

/** Input the app-feature contract uses to execute a single app feature. */
export interface AppFeatureContractHarness {
  readonly feature: AppFeatureDefinition;
  readonly services: ReadonlyArray<AppFeatureContractService>;
  readonly expectNoActivation?: boolean;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

interface RecordedAppFeatureService {
  readonly view: AppFeatureServiceView;
  readonly env: Map<string, string>;
  mutated: boolean;
}

const matchesActivation = (feature: AppFeatureDefinition, service: AppFeatureContractService): boolean => {
  const match = feature.activatedBy?.services;
  if (match === undefined) return true;
  const typeOk = match.type === undefined || service.serviceType === match.type;
  const featureOk = match.hasFeature === undefined || (service.featureIds ?? []).includes(match.hasFeature);
  return typeOk && featureOk;
};

const matchesSelectors = (feature: AppFeatureDefinition, service: AppFeatureContractService): boolean => {
  const selectors = feature.selectors;
  if (selectors === undefined) return true;
  if (selectors.types?.includes(service.serviceType)) return true;
  if (service.framework !== undefined && selectors.framework?.includes(service.framework)) return true;
  if (selectors.hasFeature?.some((id) => (service.featureIds ?? []).includes(id))) return true;
  if (selectors.names?.includes(service.serviceName)) return true;
  return false;
};

const makeRecordingAppFeatureContext = (
  input: AppFeatureContractHarness,
  options?: { readonly forceNoSelection?: boolean },
) => {
  const selectedNames =
    options?.forceNoSelection === true
      ? []
      : input.services
          .filter((service) => matchesSelectors(input.feature, service))
          .map((service) => service.serviceName);
  const selectedSet = new Set(selectedNames);

  const records = new Map<string, RecordedAppFeatureService>();
  const forbiddenReads = new Set<string>();
  for (const service of input.services) {
    const view: AppFeatureServiceView = {
      serviceName: service.serviceName,
      serviceType: service.serviceType,
      base: service.base ?? "lando",
      framework: service.framework,
      primary: service.primary ?? false,
      featureIds: service.featureIds ?? [],
      normalizedConfig: { type: service.serviceType },
    };
    records.set(service.serviceName, {
      view,
      env: new Map(Object.entries(service.environment ?? {})),
      mutated: false,
    });
  }

  const ledger = new Map<string, string>();
  const conflicts: Array<{ readonly service: string; readonly key: string }> = [];

  const mutatorsFor = (serviceName: string): AppFeatureServiceMutators => {
    const record = records.get(serviceName);
    const recordMutation = () => {
      if (record !== undefined) record.mutated = true;
    };
    const view = record?.view ?? {
      serviceName,
      serviceType: "unknown",
      base: "lando",
      primary: false,
      featureIds: [],
      normalizedConfig: { type: "unknown" },
    };
    return {
      service: view,
      addEnv: (name, value) => {
        const ledgerKey = `${serviceName}\u0000${name}`;
        const existing = ledger.get(ledgerKey);
        if (existing !== undefined && existing !== value) conflicts.push({ service: serviceName, key: name });
        ledger.set(ledgerKey, value);
        record?.env.set(name, value);
        recordMutation();
      },
      addMount: recordMutation,
      setAppMount: recordMutation,
      addBuildStep: recordMutation,
      addStorage: recordMutation,
      addEndpoint: recordMutation,
      addDependency: recordMutation,
      addHostAlias: recordMutation,
      setHealthcheck: recordMutation,
      setCerts: recordMutation,
      setEntrypoint: recordMutation,
      setCommand: recordMutation,
      setArtifact: recordMutation,
      setUser: recordMutation,
      setWorkingDirectory: recordMutation,
    };
  };

  const context: AppFeatureContext = {
    featureId: input.feature.id,
    ...(input.appName === undefined ? {} : { appName: input.appName }),
    appRoot: input.appRoot ?? "/srv/apps/myapp",
    config: input.config ?? {},
    selected: selectedNames
      .map((name) => records.get(name)?.view)
      .filter((view): view is AppFeatureServiceView => view !== undefined),
    forEachSelected: (mutate) => {
      for (const name of selectedNames) mutate(mutatorsFor(name));
    },
    select: (name) => (selectedSet.has(name) ? mutatorsFor(name) : undefined),
  };

  const proxiedContext = new Proxy(context, {
    get(target, property, receiver) {
      if (typeof property === "string" && providerCapabilityReads.has(property)) forbiddenReads.add(property);
      return Reflect.get(target, property, receiver);
    },
  });

  return { context: proxiedContext, records, selectedNames, conflicts, forbiddenReads };
};

/**
 * Run the app-feature contract: a feature exposes a stable id/priority/apply
 * hook; its `apply` selects service drafts through the published selector
 * surface, mutates each selected draft idempotently (a divergent write is a
 * conflict), never inspects provider capabilities, and surfaces its
 * `requires.globalServices` declarations.
 */
export const runAppFeatureContract = (
  input: AppFeatureContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const feature = input.feature;

    yield* requireAppFeature(isNonEmptyString(feature.id), "app feature exposes a non-empty id", feature.id);
    yield* requireAppFeature(
      Number.isFinite(feature.priority),
      "app feature exposes a finite priority",
      feature.priority,
    );
    yield* requireAppFeature(
      typeof feature.apply === "function",
      "app feature apply is callable",
      typeof feature.apply,
    );
    const globalServices = feature.requires?.globalServices ?? [];
    yield* requireAppFeature(
      globalServices.every(isNonEmptyString),
      "app feature requires.globalServices entries are non-empty ids",
      globalServices,
    );

    const activatedServices = input.services.filter((service) => matchesActivation(feature, service));
    const expectNoActivation =
      input.expectNoActivation === true ||
      (feature.activatedBy !== undefined && activatedServices.length === 0);

    if (expectNoActivation) {
      const { context, records, selectedNames, forbiddenReads } = makeRecordingAppFeatureContext(input, {
        forceNoSelection: true,
      });
      const applyExit = yield* Effect.exit(feature.apply(context));
      if (Exit.isFailure(applyExit)) {
        yield* Effect.fail(appFeatureFailure("app feature apply succeeds", Cause.pretty(applyExit.cause)));
        return;
      }

      const mutatedServices = Array.from(records.entries())
        .filter(([, record]) => record.mutated)
        .map(([serviceName]) => serviceName);
      yield* requireAppFeature(
        selectedNames.length === 0 && mutatedServices.length === 0,
        "app feature with no activation match is a no-op (no mutation, no selected services)",
        { selectedNames, mutatedServices },
      );
      yield* requireAppFeature(
        forbiddenReads.size === 0,
        "app feature does not inspect provider capabilities",
        Array.from(forbiddenReads),
      );
      return;
    }

    yield* requireAppFeature(
      feature.activatedBy === undefined || activatedServices.length > 0,
      "app feature activation matches at least one seeded service",
      { activatedBy: feature.activatedBy },
    );

    const { context, records, selectedNames, conflicts, forbiddenReads } =
      makeRecordingAppFeatureContext(input);

    yield* requireAppFeature(
      selectedNames.length > 0,
      "app feature selectors match at least one service draft",
      { selectors: feature.selectors },
    );

    const applyExit = yield* Effect.exit(feature.apply(context));
    if (Exit.isFailure(applyExit)) {
      yield* Effect.fail(appFeatureFailure("app feature apply succeeds", Cause.pretty(applyExit.cause)));
      return;
    }

    yield* requireAppFeature(
      forbiddenReads.size === 0,
      "app feature does not inspect provider capabilities",
      Array.from(forbiddenReads),
    );

    yield* requireAppFeature(
      conflicts.length === 0,
      "app feature mutations are idempotent (no divergent writes)",
      conflicts,
    );

    const requiresEffect = yield* Effect.exit(feature.apply(makeRecordingAppFeatureContext(input).context));
    yield* requireAppFeature(
      Exit.isSuccess(requiresEffect),
      "app feature apply is replay-safe",
      Exit.isFailure(requiresEffect) ? Cause.pretty(requiresEffect.cause) : undefined,
    );

    const mutatedSelected = selectedNames.some((name) => records.get(name)?.mutated === true);
    yield* requireAppFeature(
      selectedNames.length === 0 || mutatedSelected,
      "app feature mutates at least one selected service draft",
      { selectedNames },
    );
  });

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "../errors/index.ts";
import {
  type AppRef,
  FileSyncEngineCapabilities,
  type FileSyncEventChunk,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  type FileSyncSetupOptions,
} from "../schema/index.ts";
import type { FileSyncEngineShape, FileSyncError } from "../services/index.ts";

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

import type { RoutePlan } from "../schema/index.ts";
import type { ProxyServiceShape } from "../services/index.ts";

const proxyContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ProxyService contract failed: ${assertion}`, assertion, details });

const requireProxyContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(proxyContractFailure(assertion, details));

export const runProxyServiceContract = (proxy: ProxyServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireProxyContract(
      typeof proxy.id === "string" && proxy.id.length > 0,
      "id is a non-empty string",
      proxy.id,
    );

    yield* proxy.setup().pipe(Effect.mapError((d) => proxyContractFailure("setup resolves", d)));

    const testAppId = AppId.make("contract-test-app");
    const testRoutes: ReadonlyArray<RoutePlan> = [
      { hostname: "web.contract-test-app.lndo.site", scheme: "https", service: ServiceName.make("web") },
    ];

    yield* proxy
      .applyRoutes(testRoutes, testAppId)
      .pipe(Effect.mapError((d) => proxyContractFailure("applyRoutes resolves", d)));

    yield* proxy
      .removeRoutes(testAppId)
      .pipe(Effect.mapError((d) => proxyContractFailure("removeRoutes resolves", d)));

    yield* proxy
      .removeRoutes(testAppId)
      .pipe(Effect.mapError((d) => proxyContractFailure("removeRoutes is idempotent", d)));
  });

export const makeTestProxyService = (): ProxyServiceShape & {
  readonly routesByApp: ReadonlyMap<string, ReadonlyArray<RoutePlan>>;
} => {
  const routesByApp = new Map<string, ReadonlyArray<RoutePlan>>();
  return {
    id: "test",
    setup: () => Effect.void,
    applyRoutes: (routes, appId) =>
      Effect.sync(() => {
        routesByApp.set(String(appId), routes);
      }),
    removeRoutes: (appId) =>
      Effect.sync(() => {
        routesByApp.delete(String(appId));
      }),
    routesByApp,
  };
};

export const TestProxyService: ProxyServiceShape = makeTestProxyService();

import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  CertificateResult,
  CertificateSpec,
} from "../services/index.ts";

const caContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `CertificateAuthority contract failed: ${assertion}`, assertion, details });

const requireCaContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(caContractFailure(assertion, details));

export const runCaContract = (ca: CertificateAuthorityShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireCaContract(
      typeof ca.id === "string" && ca.id.length > 0,
      "id is a non-empty string",
      ca.id,
    );

    yield* ca.setup({ force: false }).pipe(Effect.mapError((d) => caContractFailure("setup resolves", d)));

    const certResult = yield* ca
      .issueCert({ cn: "test.lndo.site", sans: ["*.test.lndo.site"] })
      .pipe(Effect.mapError((d) => caContractFailure("issueCert resolves", d)));

    yield* requireCaContract(
      typeof certResult.certPath === "string" && certResult.certPath.length > 0,
      "issueCert result has non-empty certPath",
      certResult,
    );
    yield* requireCaContract(
      typeof certResult.keyPath === "string" && certResult.keyPath.length > 0,
      "issueCert result has non-empty keyPath",
      certResult,
    );
    yield* requireCaContract(
      typeof certResult.caPath === "string" && certResult.caPath.length > 0,
      "issueCert result has non-empty caPath",
      certResult,
    );

    yield* ca
      .setup({ force: false, skipTrustInstall: true })
      .pipe(Effect.mapError((d) => caContractFailure("setup with skipTrustInstall resolves", d)));
  });

export const makeTestCertificateAuthority = (): CertificateAuthorityShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        (calls as Array<{ op: "setup"; opts: CaSetupOptions }>).push({ op: "setup", opts });
      }),
    issueCert: (spec) =>
      Effect.sync((): CertificateResult => {
        (calls as Array<{ op: "issueCert"; spec: CertificateSpec }>).push({ op: "issueCert", spec });
        return {
          certPath: `/tmp/test-certs/${spec.cn}.crt`,
          keyPath: `/tmp/test-certs/${spec.cn}.key`,
          caPath: "/tmp/test-certs/ca.crt",
        };
      }),
    calls,
  };
};

export const TestCertificateAuthority: CertificateAuthorityShape = makeTestCertificateAuthority();

import type { SshAgentSocket, SshServiceShape, SshSetupOptions } from "../services/index.ts";

const sshContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `SshService contract failed: ${assertion}`, assertion, details });

const requireSshContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(sshContractFailure(assertion, details));

export const runSshServiceContract = (ssh: SshServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireSshContract(
      typeof ssh.id === "string" && ssh.id.length > 0,
      "id is a non-empty string",
      ssh.id,
    );

    yield* ssh.setup({ force: false }).pipe(Effect.mapError((d) => sshContractFailure("setup resolves", d)));

    const socketResult = yield* ssh
      .getAgentSocket(AppId.make("contract-test-app"))
      .pipe(Effect.mapError((d) => sshContractFailure("getAgentSocket resolves", d)));

    yield* requireSshContract(
      typeof socketResult.socketPath === "string" && socketResult.socketPath.length > 0,
      "getAgentSocket result has non-empty socketPath",
      socketResult,
    );

    yield* ssh
      .setup({ force: true })
      .pipe(Effect.mapError((d) => sshContractFailure("setup with force:true resolves", d)));
  });

export const makeTestSshService = (): SshServiceShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: SshSetupOptions }
    | { readonly op: "getAgentSocket"; readonly appId: AppId }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: SshSetupOptions }
    | { readonly op: "getAgentSocket"; readonly appId: AppId }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        (calls as Array<{ op: "setup"; opts: SshSetupOptions }>).push({ op: "setup", opts });
      }),
    getAgentSocket: (appId) =>
      Effect.sync((): SshAgentSocket => {
        (calls as Array<{ op: "getAgentSocket"; appId: AppId }>).push({ op: "getAgentSocket", appId });
        return { socketPath: `/tmp/test-ssh/${String(appId)}.sock`, appId };
      }),
    calls,
  };
};

export const TestSshService: SshServiceShape = makeTestSshService();

import type { HealthcheckResult, HealthcheckRunError, HealthcheckRunnerShape } from "../services/index.ts";

const healthcheckContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `HealthcheckRunner contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireHealthcheckContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(healthcheckContractFailure(assertion, details));

export const runHealthcheckContract = (
  runner: HealthcheckRunnerShape,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireHealthcheckContract(
      typeof runner.id === "string" && runner.id.length > 0,
      "id is a non-empty string",
      runner.id,
    );

    const testPlan: HealthcheckPlan = {
      kind: "command",
      command: ["sh", "-c", "exit 0"],
      intervalSeconds: 5,
      timeoutSeconds: 30,
      retries: 3,
    };

    const result = yield* runner
      .run(testPlan, AppId.make("contract-test-app"), ServiceName.make("web"))
      .pipe(Effect.mapError((d: HealthcheckRunError) => healthcheckContractFailure("run resolves", d)));

    yield* requireHealthcheckContract(
      typeof result.healthy === "boolean",
      "run result has boolean healthy",
      result,
    );
    yield* requireHealthcheckContract(
      typeof result.attempts === "number" && result.attempts > 0,
      "run result has positive attempts",
      result,
    );
  });

export const makeTestHealthcheckRunner = (): HealthcheckRunnerShape & {
  readonly calls: ReadonlyArray<{
    readonly plan: HealthcheckPlan;
    readonly appId: AppId;
    readonly service: ServiceName;
  }>;
} => {
  const calls: Array<{
    readonly plan: HealthcheckPlan;
    readonly appId: AppId;
    readonly service: ServiceName;
  }> = [];
  return {
    id: "test",
    run: (plan, appId, service) =>
      Effect.sync((): HealthcheckResult => {
        calls.push({ plan, appId, service });
        return { healthy: true, service, attempts: 1 };
      }),
    calls,
  };
};

export const TestHealthcheckRunner: HealthcheckRunnerShape = makeTestHealthcheckRunner();

import type { PortCollision, ScanResult, UrlScannerShape } from "../services/index.ts";

const scannerContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `UrlScanner contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireScannerContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(scannerContractFailure(assertion, details));

export const runScannerContract = (scanner: UrlScannerShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireScannerContract(
      typeof scanner.id === "string" && scanner.id.length > 0,
      "id is a non-empty string",
      scanner.id,
    );

    const testAppId = AppId.make("contract-test-app");

    const scanResult = yield* scanner
      .scan(testAppId)
      .pipe(Effect.mapError((d) => scannerContractFailure("scan resolves", d)));

    yield* requireScannerContract(
      scanResult.appId === testAppId,
      "scan result appId matches input",
      scanResult,
    );
    yield* requireScannerContract(
      Array.isArray(scanResult.endpoints),
      "scan result has endpoints array",
      scanResult,
    );

    const collisions = yield* scanner
      .detectCollisions([testAppId])
      .pipe(Effect.mapError((d) => scannerContractFailure("detectCollisions resolves", d)));

    yield* requireScannerContract(
      Array.isArray(collisions),
      "detectCollisions result is an array",
      collisions,
    );
  });

export const makeTestUrlScanner = (): UrlScannerShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "scan"; readonly appId: AppId }
    | { readonly op: "detectCollisions"; readonly appIds: ReadonlyArray<AppId> }
  >;
} => {
  const calls: Array<
    | { readonly op: "scan"; readonly appId: AppId }
    | { readonly op: "detectCollisions"; readonly appIds: ReadonlyArray<AppId> }
  > = [];
  return {
    id: "test",
    scan: (appId) =>
      Effect.sync((): ScanResult => {
        calls.push({ op: "scan", appId });
        return { appId, endpoints: [] };
      }),
    detectCollisions: (appIds) =>
      Effect.sync((): ReadonlyArray<PortCollision> => {
        calls.push({ op: "detectCollisions", appIds });
        return [];
      }),
    calls,
  };
};

export const TestUrlScanner: UrlScannerShape = makeTestUrlScanner();

import type {
  HostProxyMechanism,
  HostProxyServiceShape,
  HostProxySetupOptions,
  HostProxyStatus,
} from "../services/index.ts";

const HOST_PROXY_DEFAULT_BASE_DOMAIN = "lndo.site";
const HOST_PROXY_DEFAULT_LOOPBACK = "127.0.0.1";

const hostProxyContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `HostProxyService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireHostProxyContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(hostProxyContractFailure(assertion, details));

export const runHostProxyContract = (service: HostProxyServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireHostProxyContract(
      typeof service.id === "string" && service.id.length > 0,
      "id is a non-empty string",
      service.id,
    );

    yield* service
      .setup({ mode: "auto" })
      .pipe(Effect.mapError((d) => hostProxyContractFailure("setup({ mode: 'auto' }) resolves", d)));

    const activeStatus = yield* service
      .status()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("status() resolves after setup", d)));

    yield* requireHostProxyContract(
      typeof activeStatus.active === "boolean",
      "status.active is a boolean",
      activeStatus,
    );
    yield* requireHostProxyContract(
      activeStatus.mode === "auto" || activeStatus.mode === "none",
      "status.mode is auto or none",
      activeStatus,
    );
    yield* requireHostProxyContract(
      typeof activeStatus.baseDomain === "string" && activeStatus.baseDomain.length > 0,
      "status.baseDomain is a non-empty string",
      activeStatus,
    );
    yield* requireHostProxyContract(
      typeof activeStatus.loopback === "string" && activeStatus.loopback.length > 0,
      "status.loopback is a non-empty string",
      activeStatus,
    );

    yield* service
      .setup({ mode: "none" })
      .pipe(Effect.mapError((d) => hostProxyContractFailure("setup({ mode: 'none' }) resolves", d)));

    const noneStatus = yield* service
      .status()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("status() resolves after opt-out", d)));

    yield* requireHostProxyContract(
      noneStatus.mode === "none" && noneStatus.active === false,
      "status reports mode='none' and inactive after opt-out",
      noneStatus,
    );

    yield* service
      .teardown()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("teardown() resolves", d)));
  });

export const makeTestHostProxyService = (): HostProxyServiceShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly options: HostProxySetupOptions }
    | { readonly op: "status" }
    | { readonly op: "teardown" }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly options: HostProxySetupOptions }
    | { readonly op: "status" }
    | { readonly op: "teardown" }
  > = [];

  let current: HostProxyStatus = {
    active: false,
    mode: "auto",
    mechanism: "none",
    baseDomain: HOST_PROXY_DEFAULT_BASE_DOMAIN,
    loopback: HOST_PROXY_DEFAULT_LOOPBACK,
  };

  const pickMechanism = (mode: HostProxySetupOptions["mode"]): HostProxyMechanism =>
    mode === "none" ? "skipped" : "etc-hosts";

  return {
    id: "test",
    setup: (options) =>
      Effect.sync(() => {
        calls.push({ op: "setup", options });
        current = {
          active: options.mode !== "none",
          mode: options.mode,
          mechanism: pickMechanism(options.mode),
          baseDomain: options.baseDomain ?? HOST_PROXY_DEFAULT_BASE_DOMAIN,
          loopback: options.loopback ?? HOST_PROXY_DEFAULT_LOOPBACK,
        };
      }),
    status: () =>
      Effect.sync((): HostProxyStatus => {
        calls.push({ op: "status" });
        return current;
      }),
    teardown: () =>
      Effect.sync(() => {
        calls.push({ op: "teardown" });
        current = {
          active: false,
          mode: current.mode,
          mechanism: "none",
          baseDomain: current.baseDomain,
          loopback: current.loopback,
        };
      }),
    calls,
  };
};

export const TestHostProxyService: HostProxyServiceShape = makeTestHostProxyService();

// ----- ManagedFileService contract suite ----------------------------------

const managedFileContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ManagedFileService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireManagedFileContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(managedFileContractFailure(assertion, details));

const MANAGED_FILE_CONTRACT_OWNER = "contract";

/**
 * A backend-agnostic view of a `ManagedFileService` implementation that the
 * managed-file contract suite drives. `service` is the implementation under
 * test; `base` is the resolved app root the suite stamps onto every
 * `ManagedFile`; `read`/`seed` inspect and pre-populate the working tree
 * relative to `base`; `events` returns every `ManagedFile` lifecycle event
 * emitted so far. The same suite runs against `ManagedFileServiceLive`,
 * `TestManagedFileStore`, and any host or test override of the service.
 */
export interface ManagedFileContractHarness {
  readonly name?: string;
  readonly service: Context.Tag.Service<typeof ManagedFileService>;
  readonly base: AbsolutePath;
  readonly read: (path: PortablePath) => Effect.Effect<string | null>;
  readonly seed: (path: PortablePath, content: string) => Effect.Effect<void>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

const MANAGED_FILE_CONTRACT_FORMATS = [
  { format: "text", ext: "txt", content: { kind: "text", value: "alpha=1\n" } },
  { format: "env", ext: "env", content: { kind: "structured", data: { ALPHA: "1" } } },
  { format: "json", ext: "json", content: { kind: "structured", data: { alpha: 1 } } },
  { format: "yaml", ext: "yaml", content: { kind: "structured", data: { alpha: 1 } } },
  { format: "javascript", ext: "js", content: { kind: "text", value: "export const alpha = 1;\n" } },
  { format: "typescript", ext: "ts", content: { kind: "text", value: "export const alpha = 1;\n" } },
] as const;

// No per-file `base` override: `adopt`/`release`/`remove({ path })` look up
// ledger entries with `base: undefined`, so a stamped base would break them.
const managedContractTextFile = (
  path: string,
  value: string,
  overrides: Partial<ManagedFile> = {},
): ManagedFile => ({
  id: `contract:${path}`,
  owner: MANAGED_FILE_CONTRACT_OWNER,
  path: path as PortablePath,
  mode: "file",
  format: "text",
  content: { kind: "text", value },
  ...overrides,
});

/**
 * Run the `ManagedFileService` contract assertions against a harness. Asserts
 * (in order): plan/apply agree on create; update replaces content; identical
 * re-apply is skip-unchanged; an in-place user edit reports a conflict; a path
 * escaping the base is rejected (`reason: "path"`); `adopt` makes a file
 * adopted and re-apply skip-adopted; `release` marks a file adopted; `remove`
 * deletes a managed file and a repeat remove is a no-op; the ownership marker
 * round-trips per supported format (re-apply is skip-unchanged); `block` mode
 * is idempotent and preserves user content; an interrupted update leaves the
 * file fully old or fully new (never torn); and a secret in managed content
 * never appears in an emitted event.
 */
export const runManagedFileContract = (
  harness: ManagedFileContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const apply = (files: ReadonlyArray<ManagedFile>): Effect.Effect<ManagedFileResult, ManagedFileError> =>
      Effect.scoped(service.apply(files));
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        managedFileContractFailure(assertion, cause);

    // 1. plan matches apply (create) + status reflects a managed file.
    const createFile = managedContractTextFile("create.txt", "v1\n");
    const plan: ManagedFilePlan = yield* service
      .plan([createFile])
      .pipe(Effect.mapError(failWith("plan resolves for a new file")));
    const created = yield* apply([createFile]).pipe(Effect.mapError(failWith("apply creates a new file")));
    yield* requireManagedFileContract(
      plan.entries[0]?.action === "create" && created.entries[0]?.action === "create",
      "plan and apply agree the first write is a create",
      { plan: plan.entries, apply: created.entries },
    );
    const createdContent = yield* harness.read("create.txt" as PortablePath);
    yield* requireManagedFileContract(
      createdContent !== null,
      "the created file exists in the working tree",
      createdContent,
    );
    const statusAfterCreate = yield* service.status.pipe(Effect.mapError(failWith("status resolves")));
    yield* requireManagedFileContract(
      statusAfterCreate.some(
        (info: ManagedFileInfo) =>
          info.path === "create.txt" &&
          info.owner === MANAGED_FILE_CONTRACT_OWNER &&
          info.state === "managed",
      ),
      "status reports the created file as managed",
      statusAfterCreate,
    );

    // 2. update replaces prior content wholesale.
    const updateFile = managedContractTextFile("create.txt", "v2\n");
    const updated = yield* apply([updateFile]).pipe(
      Effect.mapError(failWith("apply updates a managed file")),
    );
    yield* requireManagedFileContract(
      updated.entries[0]?.action === "update",
      "changed content yields an update",
      updated.entries,
    );
    const updatedContent = yield* harness.read("create.txt" as PortablePath);
    yield* requireManagedFileContract(
      updatedContent?.includes("v2") === true && updatedContent.includes("v1") === false,
      "an update replaces the prior managed content",
      updatedContent,
    );

    // 3. identical re-apply is skip-unchanged.
    const skipped = yield* apply([updateFile]).pipe(Effect.mapError(failWith("re-apply resolves")));
    yield* requireManagedFileContract(
      skipped.entries[0]?.action === "skip-unchanged",
      "an identical re-apply is skip-unchanged",
      skipped.entries,
    );

    // 4. an in-place user edit is reported as a conflict.
    yield* harness.seed("create.txt" as PortablePath, `${updatedContent ?? ""}tampered\n`);
    const conflicted = yield* apply([updateFile]).pipe(
      Effect.mapError(failWith("apply over a user edit resolves")),
    );
    yield* requireManagedFileContract(
      conflicted.entries[0]?.action === "conflict",
      "an in-place user edit is reported as a conflict",
      conflicted.entries,
    );

    // 5. a path escaping the base is rejected with reason "path".
    const escapeFile = managedContractTextFile("../escape.txt", "nope\n");
    const escapeResult = yield* Effect.either(apply([escapeFile]));
    yield* requireManagedFileContract(
      Either.isLeft(escapeResult) && escapeResult.left.reason === "path",
      "a path escaping the base is rejected with reason path",
      escapeResult,
    );

    // 6. adopt + skip-adopted.
    const adoptFile = managedContractTextFile("adopt.txt", "a1\n");
    yield* apply([adoptFile]).pipe(Effect.mapError(failWith("apply creates the adopt fixture")));
    yield* service.adopt("adopt.txt" as PortablePath).pipe(Effect.mapError(failWith("adopt resolves")));
    const adoptStatus = yield* service.status.pipe(Effect.mapError(failWith("status resolves after adopt")));
    yield* requireManagedFileContract(
      adoptStatus.some((info: ManagedFileInfo) => info.path === "adopt.txt" && info.state === "adopted"),
      "adopt marks the file adopted",
      adoptStatus,
    );
    const skipAdopted = yield* apply([adoptFile]).pipe(
      Effect.mapError(failWith("re-apply after adopt resolves")),
    );
    yield* requireManagedFileContract(
      skipAdopted.entries[0]?.action === "skip-adopted",
      "a re-apply after adopt is skip-adopted",
      skipAdopted.entries,
    );

    // 7. release marks a file adopted.
    const releaseFile = managedContractTextFile("release.txt", "r1\n");
    yield* apply([releaseFile]).pipe(Effect.mapError(failWith("apply creates the release fixture")));
    yield* service.release("release.txt" as PortablePath).pipe(Effect.mapError(failWith("release resolves")));
    const releaseStatus = yield* service.status.pipe(
      Effect.mapError(failWith("status resolves after release")),
    );
    yield* requireManagedFileContract(
      releaseStatus.some((info: ManagedFileInfo) => info.path === "release.txt" && info.state === "adopted"),
      "release marks the file adopted",
      releaseStatus,
    );

    // 8. remove deletes the file; a repeat remove is a no-op.
    const removeFile = managedContractTextFile("remove.txt", "x1\n");
    yield* apply([removeFile]).pipe(Effect.mapError(failWith("apply creates the remove fixture")));
    const removed = yield* service
      .remove({ owner: MANAGED_FILE_CONTRACT_OWNER, path: "remove.txt" as PortablePath })
      .pipe(Effect.mapError(failWith("remove resolves")));
    yield* requireManagedFileContract(
      removed.entries.length >= 1,
      "remove reports the removed entry",
      removed.entries,
    );
    const afterRemove = yield* harness.read("remove.txt" as PortablePath);
    yield* requireManagedFileContract(
      afterRemove === null,
      "a removed managed file is gone from the working tree",
      afterRemove,
    );
    const removeAgain = yield* service
      .remove({ owner: MANAGED_FILE_CONTRACT_OWNER, path: "remove.txt" as PortablePath })
      .pipe(Effect.mapError(failWith("a repeat remove resolves")));
    yield* requireManagedFileContract(
      removeAgain.entries.length === 0,
      "removing an already-removed file is a no-op",
      removeAgain.entries,
    );

    // 9. the ownership marker round-trips per supported format.
    for (const spec of MANAGED_FILE_CONTRACT_FORMATS) {
      const formatPath = `marker-${spec.format}.${spec.ext}`;
      const formatFile: ManagedFile = {
        id: `contract:fmt:${spec.format}`,
        owner: MANAGED_FILE_CONTRACT_OWNER,
        path: formatPath as PortablePath,
        mode: "file",
        format: spec.format,
        content: spec.content,
      };
      const createdFormat = yield* apply([formatFile]).pipe(
        Effect.mapError(failWith(`apply creates a ${spec.format} file`)),
      );
      yield* requireManagedFileContract(
        createdFormat.entries[0]?.action === "create",
        `format ${spec.format} is created`,
        createdFormat.entries,
      );
      const formatContent = yield* harness.read(formatPath as PortablePath);
      yield* requireManagedFileContract(
        formatContent !== null,
        `format ${spec.format} writes content`,
        formatContent,
      );
      const reappliedFormat = yield* apply([formatFile]).pipe(
        Effect.mapError(failWith(`re-apply for a ${spec.format} file resolves`)),
      );
      yield* requireManagedFileContract(
        reappliedFormat.entries[0]?.action === "skip-unchanged",
        `format ${spec.format} marker round-trips to skip-unchanged`,
        reappliedFormat.entries,
      );
    }

    // 10. block mode injects a fenced region into a file Lando creates, is
    // idempotent, and preserves user content added around the fence. A
    // pre-existing fence-less file is adopted, never appended, so the block is
    // created on a new path first.
    const blockFile = managedContractTextFile("block.txt", "managed block line\n", {
      mode: "block",
      marker: "contract-block",
    });
    const blockFirst = yield* apply([blockFile]).pipe(
      Effect.mapError(failWith("apply inserts a managed block")),
    );
    yield* requireManagedFileContract(
      blockFirst.entries[0]?.action === "create",
      "the first block apply creates the fenced region",
      blockFirst.entries,
    );
    const blockCreated = yield* harness.read("block.txt" as PortablePath);
    yield* harness.seed(
      "block.txt" as PortablePath,
      `# user header line\n${blockCreated ?? ""}# user footer line\n`,
    );
    const blockReapply = yield* apply([blockFile]).pipe(
      Effect.mapError(failWith("re-apply of a managed block resolves")),
    );
    yield* requireManagedFileContract(
      blockReapply.entries[0]?.action === "skip-unchanged",
      "block mode re-apply is idempotent (skip-unchanged)",
      blockReapply.entries,
    );
    const blockContent = yield* harness.read("block.txt" as PortablePath);
    const fenceOpens = (blockContent ?? "").split(">>> lando:contract-block").length - 1;
    yield* requireManagedFileContract(
      fenceOpens === 1 &&
        (blockContent ?? "").includes("user header line") &&
        (blockContent ?? "").includes("user footer line"),
      "block mode keeps exactly one fenced region and preserves user content",
      { fenceOpens, blockContent },
    );

    // 11. an interrupted update leaves the file fully old or fully new (never torn).
    const atomicFile = managedContractTextFile("atomic.txt", "alpha\n");
    yield* apply([atomicFile]).pipe(Effect.mapError(failWith("apply creates the atomic fixture")));
    const atomicBeta = managedContractTextFile("atomic.txt", "beta\n");
    yield* apply([atomicBeta]).pipe(Effect.mapError(failWith("apply updates the atomic fixture")));
    const beforeInterrupt = yield* harness.read("atomic.txt" as PortablePath);
    const atomicGamma = managedContractTextFile("atomic.txt", "gamma\n");
    const fiber = yield* Effect.fork(apply([atomicGamma]));
    yield* Fiber.interrupt(fiber);
    const afterInterrupt = yield* harness.read("atomic.txt" as PortablePath);
    const interruptedFileIsTorn =
      afterInterrupt === null ||
      !afterInterrupt.endsWith("\n") ||
      (afterInterrupt !== beforeInterrupt &&
        !(afterInterrupt.includes("gamma") && !afterInterrupt.includes("beta")));
    yield* requireManagedFileContract(
      !interruptedFileIsTorn,
      "an interrupted update leaves the file fully old or fully new, never torn",
      { beforeInterrupt, afterInterrupt },
    );

    // 12. a secret in managed content never appears in an emitted event.
    const secret = "ULW-MANAGED-SECRET-d41d8cd9f00b204e";
    const secretFile = managedContractTextFile("secret.txt", `token=${secret}\n`);
    yield* apply([secretFile]).pipe(Effect.mapError(failWith("apply of a secret-bearing file resolves")));
    const emitted = yield* harness.events();
    yield* requireManagedFileContract(emitted.length > 0, "apply emits lifecycle events", emitted.length);
    yield* requireManagedFileContract(
      !JSON.stringify(emitted).includes(secret),
      "a secret in managed content never appears in an emitted event",
      { sampleEvent: emitted[0] },
    );
    const secretOnDisk = yield* harness.read("secret.txt" as PortablePath);
    yield* requireManagedFileContract(
      secretOnDisk?.includes(secret) === true,
      "the secret is written to the working tree (sanity)",
      secretOnDisk,
    );
  });

export interface RemoteSourceContractObservations {
  readonly egressRequests: () => Effect.Effect<ReadonlyArray<RemoteSourceEgressRecord>>;
  readonly toolProvisions: () => Effect.Effect<ReadonlyArray<RemoteSourceToolProvisionRecord>>;
  readonly datasetDelegations: () => Effect.Effect<ReadonlyArray<RemoteSourceDatasetDelegationRecord>>;
  readonly finalizers: () => Effect.Effect<ReadonlyArray<RemoteSourceFinalizerRecord>>;
  readonly probes: () => Effect.Effect<ReadonlyArray<RemoteSourceProbeRecord>>;
}

export interface RemoteSourceEgressRecord {
  readonly request: { readonly url: string; readonly allowFileSource?: boolean; readonly headers?: unknown };
}

export interface RemoteSourceToolProvisionRecord {
  readonly request: DownloadRequest;
}

export interface RemoteSourceDatasetDelegationRecord {
  readonly operation: "fetch" | "send";
  readonly endpoint: DataEndpoint;
}

export interface RemoteSourceFinalizerRecord {
  readonly operation: "fetch" | "send";
  readonly remote: string;
}

export interface RemoteSourceProbeRecord {
  readonly remote: string;
  readonly env?: RemoteEnvId;
}

export interface RemoteSourceContractHarness {
  readonly name?: string;
  readonly source: RemoteSourceShape;
  readonly noPushSource: RemoteSourceShape;
  readonly config: RemoteConfig;
  readonly supportedEnv: RemoteEnvId;
  readonly protectedEnv: RemoteEnvId;
  readonly missingEnv: RemoteEnvId;
  readonly supportedDataset: DatasetKind;
  readonly unsupportedDataset: DatasetKind;
  readonly artifact: DataEndpoint;
  readonly observations: RemoteSourceContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

export interface DatasetContractObservations {
  readonly dataMoverTransfers: () => Effect.Effect<ReadonlyArray<DatasetDataMoverRecord>>;
  readonly dataMoverStreams: () => Effect.Effect<ReadonlyArray<DatasetDataMoverRecord>>;
}

export interface DatasetDataMoverRecord {
  readonly operation: "capture" | "apply";
  readonly endpoint: DataEndpoint;
  readonly command?: CommandSpec | undefined;
}

export interface DatasetContractHarness {
  readonly name?: string;
  readonly dataset: DatasetShape;
  readonly context: DatasetContext;
  readonly codeTreeContext: DatasetContext;
  readonly expectedBytes: Uint8Array;
  readonly observations: DatasetContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly readAppliedBytes: () => Effect.Effect<Uint8Array | null>;
}

const remoteSyncContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Remote sync contract failed: ${assertion}`, assertion, details });

const requireRemoteSyncContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(remoteSyncContractFailure(assertion, details));

const mapRemoteSyncFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    remoteSyncContractFailure(assertion, details);

const sameBytePayload = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null && left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const eventJson = (events: ReadonlyArray<LandoEvent>): string => JSON.stringify(events);

const commandIncludesCredential = (
  record: DatasetDataMoverRecord,
  credentials: ReadonlyArray<string>,
): boolean =>
  record.command !== undefined &&
  credentials.some(
    (credential) => credential.length > 0 && JSON.stringify(record.command).includes(credential),
  );

const stringValues = (record: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<string> =>
  Object.values(record ?? {}).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

export const runRemoteSourceContract = (
  harness: RemoteSourceContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const source = harness.source;

    yield* requireRemoteSyncContract(source.id.length > 0, "RemoteSource declares a non-empty id", source.id);
    yield* requireRemoteSyncContract(
      source.capabilities.environments === true,
      "RemoteSource declares environment listing capability",
      source.capabilities,
    );
    yield* requireRemoteSyncContract(
      source.capabilities.datasets.includes(harness.supportedDataset),
      "RemoteSource capabilities include the supported dataset",
      source.capabilities,
    );

    const firstEnvs = yield* source
      .listEnvironments(harness.config)
      .pipe(Effect.mapError(mapRemoteSyncFailure("listEnvironments resolves")));
    const secondEnvs = yield* source
      .listEnvironments(harness.config)
      .pipe(Effect.mapError(mapRemoteSyncFailure("listEnvironments is repeatable")));
    yield* requireRemoteSyncContract(
      JSON.stringify(firstEnvs) === JSON.stringify(secondEnvs) &&
        firstEnvs.some((env) => env.id === harness.supportedEnv) &&
        firstEnvs.some((env) => env.id === harness.protectedEnv && env.protected === true),
      "listEnvironments is deterministic and includes normal + protected envs",
      { firstEnvs, secondEnvs },
    );

    const locator = yield* source
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve returns a locator for a supported env/dataset")));
    const locatorAgain = yield* source
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve is repeatable")));
    yield* requireRemoteSyncContract(
      JSON.stringify(locator) === JSON.stringify(locatorAgain) &&
        locator.env === harness.supportedEnv &&
        locator.dataset === harness.supportedDataset,
      "resolve is deterministic and echoes env/dataset",
      { locator, locatorAgain },
    );

    const missingEnv = yield* Effect.either(
      source.resolve(harness.config, harness.missingEnv, harness.supportedDataset),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(missingEnv) && missingEnv.left instanceof RemoteEnvNotFoundError,
      "unknown env fails RemoteEnvNotFoundError",
      missingEnv,
    );

    const unsupportedDataset = yield* Effect.either(
      source.resolve(harness.config, harness.supportedEnv, harness.unsupportedDataset),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(unsupportedDataset) && unsupportedDataset.left instanceof RemoteDatasetUnsupportedError,
      "unknown dataset fails RemoteDatasetUnsupportedError",
      unsupportedDataset,
    );

    const egressBefore = (yield* harness.observations.egressRequests()).length;
    const toolBefore = (yield* harness.observations.toolProvisions()).length;
    const delegationsBefore = (yield* harness.observations.datasetDelegations()).length;
    const finalizersBefore = (yield* harness.observations.finalizers()).length;
    const fetched = yield* Effect.scoped(source.fetch(locator)).pipe(
      Effect.mapError(mapRemoteSyncFailure("fetch resolves under a Scope")),
    );
    yield* requireRemoteSyncContract(
      fetched._tag === "hostArchive" || fetched._tag === "stream" || fetched._tag === "artifact",
      "fetch returns a portable DataEndpoint",
      fetched,
    );
    const egressAfterFetch = yield* harness.observations.egressRequests();
    const toolsAfterFetch = yield* harness.observations.toolProvisions();
    const delegationsAfterFetch = yield* harness.observations.datasetDelegations();
    const finalizersAfterFetch = yield* harness.observations.finalizers();
    const newFetchEgress = egressAfterFetch.slice(egressBefore);
    const newFetchTools = toolsAfterFetch.slice(toolBefore);
    const newFetchDelegations = delegationsAfterFetch.slice(delegationsBefore);
    const newFetchFinalizers = finalizersAfterFetch.slice(finalizersBefore);
    const toolProvisioningSatisfied =
      source.capabilities.tool === undefined ||
      (newFetchTools.length > 0 &&
        newFetchTools.some(
          (record) =>
            record.request.destination.kind === "memory" &&
            record.request.url.startsWith("https://") &&
            record.request.callerId?.includes("tool-provision") === true,
        ));
    yield* requireRemoteSyncContract(
      newFetchEgress.some((record) => record.request.url === locator.endpoint) &&
        toolProvisioningSatisfied &&
        newFetchDelegations.some(
          (record) => record.operation === "fetch" && record.endpoint._tag === fetched._tag,
        ) &&
        newFetchFinalizers.some((record) => record.operation === "fetch" && record.remote === source.id),
      "fetch records egress, tool provisioning, dataset delegation, and Scope finalization",
      {
        before: { egressBefore, toolBefore, delegationsBefore, finalizersBefore },
        after: { egressAfterFetch, toolsAfterFetch, delegationsAfterFetch, finalizersAfterFetch },
      },
    );

    const fetchInterruptFinalizersBefore = (yield* harness.observations.finalizers()).length;
    const fetchFiber = yield* Effect.fork(
      Effect.scoped(source.fetch(locator, { expectedDigest: "interrupt-contract" })),
    );
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(fetchFiber);
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > fetchInterruptFinalizersBefore,
      "interrupted fetch finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const noPushLocator = yield* harness.noPushSource
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("no-push source resolves supported locator")));
    const noPushSend = yield* Effect.either(
      Effect.scoped(harness.noPushSource.send(noPushLocator, harness.artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(noPushSend) && noPushSend.left instanceof RemoteDatasetUnsupportedError,
      "push is rejected when capabilities.push is false",
      noPushSend,
    );

    const protectedLocator = yield* source
      .resolve(harness.config, harness.protectedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve returns a protected locator")));
    const protectedWithoutForce = yield* Effect.either(
      Effect.scoped(source.send(protectedLocator, harness.artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(protectedWithoutForce) && protectedWithoutForce.left instanceof RemoteProtectedEnvError,
      "protected env push requires explicit confirmation",
      protectedWithoutForce,
    );

    const sendEgressBefore = (yield* harness.observations.egressRequests()).length;
    const sendDelegationsBefore = (yield* harness.observations.datasetDelegations()).length;
    const sendFinalizersBefore = (yield* harness.observations.finalizers()).length;
    yield* Effect.scoped(
      source.send(protectedLocator, harness.artifact, { protectedEnvConfirmed: true }),
    ).pipe(Effect.mapError(mapRemoteSyncFailure("confirmed protected send resolves under a Scope")));
    const egressAfterSend = yield* harness.observations.egressRequests();
    const delegationsAfterSend = yield* harness.observations.datasetDelegations();
    const finalizersAfterSend = yield* harness.observations.finalizers();
    const newSendEgress = egressAfterSend.slice(sendEgressBefore);
    const newSendDelegations = delegationsAfterSend.slice(sendDelegationsBefore);
    const newSendFinalizers = finalizersAfterSend.slice(sendFinalizersBefore);
    yield* requireRemoteSyncContract(
      newSendFinalizers.some((record) => record.operation === "send" && record.remote === source.id) &&
        newSendEgress.some((record) => record.request.url === protectedLocator.endpoint) &&
        newSendDelegations.some(
          (record) => record.operation === "send" && record.endpoint._tag === harness.artifact._tag,
        ),
      "send records egress, dataset delegation, and Scope finalization",
      {
        before: {
          egressBefore: sendEgressBefore,
          delegationsBefore: sendDelegationsBefore,
          finalizersBefore: sendFinalizersBefore,
        },
        after: { egressAfterSend, delegationsAfterSend, finalizersAfterSend },
      },
    );

    const sendInterruptFinalizersBefore = (yield* harness.observations.finalizers()).length;
    const sendFiber = yield* Effect.fork(
      Effect.scoped(
        source.send(protectedLocator, harness.artifact, {
          protectedEnvConfirmed: true,
          expectedDigest: "interrupt-contract",
        }),
      ),
    );
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(sendFiber);
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > sendInterruptFinalizersBefore,
      "interrupted send finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const probesBefore = (yield* harness.observations.probes()).length;
    const testResult = yield* (
      source.test?.(harness.config, harness.supportedEnv) ??
      Effect.fail(remoteSyncContractFailure("RemoteSource exposes a readiness test method"))
    ).pipe(Effect.mapError(mapRemoteSyncFailure("readiness test resolves")));
    yield* requireRemoteSyncContract(
      testResult.ok === true &&
        (yield* harness.observations.probes()).length > probesBefore &&
        (yield* harness.observations.probes()).some(
          (record) => record.remote === source.id && record.env === harness.supportedEnv,
        ),
      "readiness uses the probe/test seam instead of ad-hoc retry",
      testResult,
    );

    const events = yield* harness.events();
    yield* requireRemoteSyncContract(
      events.some((event) => event.eventName === "pre-dataset-fetch") &&
        events.some((event) => event.eventName === "post-dataset-fetch") &&
        events.some((event) => event.eventName === "pre-dataset-send") &&
        events.some((event) => event.eventName === "post-dataset-send"),
      "fetch/send emit Sync lifecycle events",
      events,
    );
    const remoteSecretValues = [
      ...Object.entries(harness.config)
        .filter(([key]) => key !== "source")
        .flatMap(([, value]) => (typeof value === "string" ? [value] : [])),
      ...stringValues(locator.metadata),
      ...stringValues(protectedLocator.metadata),
    ];
    yield* requireRemoteSyncContract(
      remoteSecretValues.every((secret) => !eventJson(events).includes(secret)),
      "RemoteSource lifecycle events redact tokens and remote secrets",
      { remoteSecretValues, events },
    );
  });

export const runDatasetContract = (harness: DatasetContractHarness): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const dataset = harness.dataset;

    yield* requireRemoteSyncContract(dataset.id.length > 0, "Dataset declares a non-empty id", dataset.id);
    yield* requireRemoteSyncContract(
      dataset.capabilities.capture === true && dataset.capabilities.apply === true,
      "Dataset declares capture/apply capabilities honestly",
      dataset.capabilities,
    );
    yield* requireRemoteSyncContract(
      dataset.artifactFormat.endpoint === "hostArchive" || dataset.artifactFormat.endpoint === "stream",
      "Dataset declares a portable artifact format",
      dataset.artifactFormat,
    );

    const localStore = yield* dataset
      .localStore(harness.context)
      .pipe(Effect.mapError(mapRemoteSyncFailure("localStore resolves")));
    yield* requireRemoteSyncContract(localStore !== null, "Dataset reports its local store", localStore);

    const transfersBefore = (yield* harness.observations.dataMoverTransfers()).length;
    const streamsBefore = (yield* harness.observations.dataMoverStreams()).length;
    const artifact = yield* Effect.scoped(dataset.capture(harness.context)).pipe(
      Effect.mapError(mapRemoteSyncFailure("capture produces an artifact")),
    );
    yield* requireRemoteSyncContract(
      artifact._tag === "hostArchive" || artifact._tag === "stream" || artifact._tag === "artifact",
      "capture returns a portable DataEndpoint",
      artifact,
    );
    const applied = yield* Effect.scoped(dataset.apply(harness.context, artifact, { snapshot: true })).pipe(
      Effect.mapError(mapRemoteSyncFailure("apply consumes the artifact")),
    );
    yield* requireRemoteSyncContract(applied.changed === true, "first apply reports a change", applied);
    const appliedBytes = yield* harness.readAppliedBytes();
    yield* requireRemoteSyncContract(
      sameBytePayload(appliedBytes, harness.expectedBytes),
      "capture -> apply round-trips dataset bytes",
      { expected: Array.from(harness.expectedBytes), actual: appliedBytes ? Array.from(appliedBytes) : null },
    );
    const transfersAfterApply = yield* harness.observations.dataMoverTransfers();
    const streamsAfterApply = yield* harness.observations.dataMoverStreams();
    const newApplyTransfers = transfersAfterApply.slice(transfersBefore);
    const newApplyStreams = streamsAfterApply.slice(streamsBefore);
    yield* requireRemoteSyncContract(
      newApplyTransfers.length >= 2 &&
        newApplyTransfers.some(
          (record) => record.operation === "capture" && record.endpoint._tag === artifact._tag,
        ) &&
        newApplyTransfers.some(
          (record) => record.operation === "apply" && record.endpoint._tag === artifact._tag,
        ) &&
        newApplyStreams.some(
          (record) => record.operation === "capture" && record.endpoint._tag === artifact._tag,
        ),
      "capture/apply delegate byte movement to DataMover hooks",
      {
        before: { transfersBefore, streamsBefore },
        after: { transfers: transfersAfterApply, streams: streamsAfterApply },
      },
    );
    const credentialValues = Object.values(harness.context.creds ?? {});
    yield* requireRemoteSyncContract(
      [...newApplyTransfers, ...newApplyStreams].every(
        (record) => !commandIncludesCredential(record, credentialValues),
      ),
      "Dataset credentials are not passed through service command argv",
      { credentials: credentialValues, transfers: newApplyTransfers, streams: newApplyStreams },
    );

    const replay = yield* Effect.scoped(dataset.apply(harness.context, artifact)).pipe(
      Effect.mapError(mapRemoteSyncFailure("replay apply resolves")),
    );
    yield* requireRemoteSyncContract(
      replay.changed === false,
      "apply is idempotent/replay-safe for the same artifact",
      replay,
    );

    const codeTreeCapture = yield* Effect.either(Effect.scoped(dataset.capture(harness.codeTreeContext)));
    const codeTreeApply = yield* Effect.either(
      Effect.scoped(dataset.apply(harness.codeTreeContext, artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(codeTreeCapture) &&
        codeTreeCapture.left instanceof DatasetBindingError &&
        Either.isLeft(codeTreeApply) &&
        codeTreeApply.left instanceof DatasetBindingError,
      "code-tree-targeting bindings fail DatasetBindingError",
      { codeTreeCapture, codeTreeApply },
    );

    const events = yield* harness.events();
    yield* requireRemoteSyncContract(
      events.some((event) => event.eventName === "pre-dataset-capture") &&
        events.some((event) => event.eventName === "post-dataset-capture") &&
        events.some((event) => event.eventName === "pre-dataset-apply") &&
        events.some((event) => event.eventName === "post-dataset-apply"),
      "Dataset emits capture/apply lifecycle events",
      events,
    );
    yield* requireRemoteSyncContract(
      credentialValues.every((secret) => !eventJson(events).includes(secret)),
      "Dataset lifecycle events redact credentials and dataset secrets",
      { credentialValues, events },
    );
  });

export const makeRemoteSourceContractSuite = runRemoteSourceContract;
export const makeDatasetContractSuite = runDatasetContract;

export type TunnelServiceEgressRecord = { readonly url: string; readonly callerId?: string | undefined };
export type TunnelServiceToolProvisionRecord = { readonly request: DownloadRequest };
export type TunnelServiceFinalizerRecord = { readonly sessionId: string; readonly provider: string };
export type TunnelServiceDetachedStateRecord = {
  readonly operation: "record" | "reconcile" | "remove";
  readonly sessionId: string;
};
export type TunnelServiceProbeRecord = {
  readonly sessionId: string;
  readonly publicUrl?: string | undefined;
};

export interface TunnelServiceContractObservations {
  readonly egressRequests: () => Effect.Effect<ReadonlyArray<TunnelServiceEgressRecord>>;
  readonly toolProvisions: () => Effect.Effect<ReadonlyArray<TunnelServiceToolProvisionRecord>>;
  readonly finalizers: () => Effect.Effect<ReadonlyArray<TunnelServiceFinalizerRecord>>;
  readonly detachedState: () => Effect.Effect<ReadonlyArray<TunnelServiceDetachedStateRecord>>;
  readonly probes: () => Effect.Effect<ReadonlyArray<TunnelServiceProbeRecord>>;
  readonly dataMoverUses: () => Effect.Effect<ReadonlyArray<unknown>>;
  readonly redactionTokens: ReadonlyArray<string>;
}

export interface TunnelServiceContractHarness {
  readonly name: string;
  readonly service: TunnelServiceShape;
  readonly unsupportedTarget: TunnelTarget;
  readonly observations: TunnelServiceContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

const tunnelContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `TunnelService contract failed: ${assertion}`, assertion, details });

const requireTunnelContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(tunnelContractFailure(assertion, details));

const mapTunnelFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    tunnelContractFailure(assertion, details);

const tunnelEventJson = (events: ReadonlyArray<LandoEvent>): string => JSON.stringify(events);

export const runTunnelServiceContract = (
  harness: TunnelServiceContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const target: TunnelTarget = { _tag: "route", routeId: "https", hostname: "app.lndo.site" };

    yield* requireTunnelContract(service.id.length > 0, "TunnelService declares a non-empty id", service.id);
    yield* requireTunnelContract(
      typeof service.capabilities.ephemeralUrls === "boolean" &&
        typeof service.capabilities.detached === "boolean" &&
        typeof service.capabilities.connectorBinary === "boolean",
      "TunnelService declares capability flags honestly",
      service.capabilities,
    );

    const unsupportedStart = yield* Effect.either(
      Effect.scoped(service.start({ app: TEST_APP_ID, target: harness.unsupportedTarget })),
    );
    yield* requireTunnelContract(
      Either.isLeft(unsupportedStart) && unsupportedStart.left instanceof TunnelTargetUnresolvedError,
      "unsupported app target fails TunnelTargetUnresolvedError",
      unsupportedStart,
    );

    const egressBefore = (yield* harness.observations.egressRequests()).length;
    const toolsBefore = (yield* harness.observations.toolProvisions()).length;
    const probesBefore = (yield* harness.observations.probes()).length;
    const finalizersBefore = (yield* harness.observations.finalizers()).length;
    const session = yield* Effect.scoped(service.start({ app: TEST_APP_ID, target })).pipe(
      Effect.mapError(mapTunnelFailure("foreground start resolves under a Scope")),
    );
    yield* requireTunnelContract(
      session.provider === service.id && session.status === "ready" && session.detached === false,
      "foreground start returns a ready session for the selected provider",
      session,
    );
    const egressAfterStart = yield* harness.observations.egressRequests();
    const toolsAfterStart = yield* harness.observations.toolProvisions();
    const probesAfterStart = yield* harness.observations.probes();
    const finalizersAfterStart = yield* harness.observations.finalizers();
    const toolSatisfied =
      service.capabilities.connectorBinary === false ||
      toolsAfterStart.slice(toolsBefore).some((record) => record.request.url.startsWith("https://"));
    yield* requireTunnelContract(
      egressAfterStart.slice(egressBefore).some((record) => record.url.startsWith("https://")) &&
        toolSatisfied &&
        probesAfterStart.slice(probesBefore).some((record) => record.sessionId === session.id) &&
        finalizersAfterStart.slice(finalizersBefore).some((record) => record.sessionId === session.id),
      "start records HttpClient egress, tool provisioning, readiness probe, and Scope finalization",
      { egressAfterStart, toolsAfterStart, probesAfterStart, finalizersAfterStart },
    );

    const status = yield* service
      .status({ sessionId: session.id })
      .pipe(Effect.mapError(mapTunnelFailure("status resolves for a started session")));
    const listed = yield* service
      .list({ app: TEST_APP_ID })
      .pipe(Effect.mapError(mapTunnelFailure("list resolves for an app filter")));
    yield* requireTunnelContract(
      status === "ready" && listed.some((entry) => entry.id === session.id),
      "status/list report a started session",
      { status, listed },
    );
    yield* service
      .stop({ sessionId: session.id })
      .pipe(Effect.mapError(mapTunnelFailure("stop resolves for a started session")));
    const stopped = yield* service
      .status({ sessionId: session.id })
      .pipe(Effect.mapError(mapTunnelFailure("status resolves after stop")));
    yield* requireTunnelContract(stopped === "stopped", "stop updates session status to stopped", stopped);

    let detached: TunnelSession | undefined;
    if (service.capabilities.detached) {
      detached = yield* Effect.scoped(service.start({ app: TEST_APP_ID, target, detached: true })).pipe(
        Effect.mapError(mapTunnelFailure("detached start resolves when advertised")),
      );
    }
    if (detached !== undefined) {
      yield* requireTunnelContract(
        detached.detached === true,
        "detached start returns a detached session when advertised",
        detached,
      );
    }
    if (detached !== undefined) {
      const detachedStatus = yield* service
        .status({ sessionId: detached.id })
        .pipe(Effect.mapError(mapTunnelFailure("status resolves for a detached session")));
      const detachedListed = yield* service
        .list({ app: TEST_APP_ID })
        .pipe(Effect.mapError(mapTunnelFailure("list resolves for a detached session")));
      yield* requireTunnelContract(
        detachedStatus === "ready" && detachedListed.some((entry) => entry.id === detached.id),
        "status/list reconcile detached session state when advertised",
        { status: detachedStatus, listed: detachedListed },
      );
      yield* service
        .stop({ sessionId: detached.id })
        .pipe(Effect.mapError(mapTunnelFailure("stop resolves for a detached session")));
      const detachedStopped = yield* service
        .status({ sessionId: detached.id })
        .pipe(Effect.mapError(mapTunnelFailure("status resolves after detached stop")));
      yield* requireTunnelContract(
        detachedStopped === "stopped",
        "detached stop updates session status to stopped when advertised",
        detachedStopped,
      );
    }

    const finalizersBeforeInterrupt = (yield* harness.observations.finalizers()).length;
    const fiber = yield* Effect.fork(Effect.scoped(service.start({ app: TEST_APP_ID, target })));
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(fiber);
    yield* requireTunnelContract(
      (yield* harness.observations.finalizers()).length > finalizersBeforeInterrupt,
      "interrupted foreground start finalizes connector resources",
      yield* harness.observations.finalizers(),
    );

    const detachedRecords = yield* harness.observations.detachedState();
    if (detached !== undefined) {
      yield* requireTunnelContract(
        detachedRecords.some((record) => record.operation === "record" && record.sessionId === detached.id) &&
          detachedRecords.some(
            (record) => record.operation === "reconcile" && record.sessionId === detached.id,
          ) &&
          detachedRecords.some((record) => record.operation === "remove" && record.sessionId === detached.id),
        "detached sessions record, reconcile, and remove StateStore-backed state when advertised",
        detachedRecords,
      );
    }

    const events = yield* harness.events();
    yield* requireTunnelContract(
      events.some((event) => event.eventName === "pre-tunnel-start") &&
        events.some((event) => event.eventName === "post-tunnel-start") &&
        events.some((event) => event.eventName === "tunnel-ready") &&
        events.some((event) => event.eventName === "pre-tunnel-stop") &&
        events.some((event) => event.eventName === "post-tunnel-stop") &&
        events.some((event) => event.eventName === "tunnel-status"),
      "TunnelService emits the Tunnel lifecycle event scope",
      events,
    );
    yield* requireTunnelContract(
      harness.observations.redactionTokens.every((secret) => !tunnelEventJson(events).includes(secret)),
      "Tunnel lifecycle events redact public URLs, auth URLs, and tokens",
      { tokens: harness.observations.redactionTokens, events },
    );
    yield* requireTunnelContract(
      (yield* harness.observations.dataMoverUses()).length === 0,
      "TunnelService never delegates local byte movement through DataMover",
      yield* harness.observations.dataMoverUses(),
    );
  });

export const makeTunnelServiceContractSuite = runTunnelServiceContract;

const stateStoreContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `StateStore contract failed: ${assertion}`, assertion, details });

const requireStateStoreContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(stateStoreContractFailure(assertion, details));

/**
 * A backend-agnostic view of a `StateStore` implementation that the state-store
 * contract suite drives. `store` is the implementation under test, `root` is a
 * fresh isolated `{ path }` root stamped onto every bucket spec, and the raw
 * hooks expose just enough storage inspection to assert durable framing,
 * atomicity, quarantine sidecars, and optional disk-only stale lock takeover.
 */
export interface StateStoreContractHarness {
  readonly name?: string;
  readonly store: StateStoreShape;
  readonly root: AbsolutePath;
  readonly readRaw: (file: AbsolutePath) => Effect.Effect<Uint8Array | null>;
  readonly list: (dir: AbsolutePath) => Effect.Effect<ReadonlyArray<string>>;
  readonly writeRaw: (file: AbsolutePath, bytes: Uint8Array | string) => Effect.Effect<void>;
  readonly plantStaleLock?: (file: AbsolutePath) => Effect.Effect<void>;
}

const StateStoreContractDoc = Schema.Struct({ count: Schema.Number, label: Schema.String });
type StateStoreContractDoc = typeof StateStoreContractDoc.Type;

const StateStoreContractLine = Schema.Struct({ value: Schema.String });
type StateStoreContractLine = typeof StateStoreContractLine.Type;

const StateStoreContractLegacyDoc = Schema.Struct({ n: Schema.Number });

const StateStoreContractMigratedDoc = Schema.Struct({
  count: Schema.Number,
  label: Schema.String,
  from: Schema.Number,
});
type StateStoreContractMigratedDoc = typeof StateStoreContractMigratedDoc.Type;

const stateStoreDocSpec = (
  harness: StateStoreContractHarness,
  key: string,
  overrides: Partial<StateBucketSpec<StateStoreContractDoc, StateStoreContractDoc>> = {},
): StateBucketSpec<StateStoreContractDoc, StateStoreContractDoc> => ({
  root: { path: harness.root },
  key,
  schema: StateStoreContractDoc,
  version: 1,
  ...overrides,
});

const stateStoreMigratedDocSpec = (
  harness: StateStoreContractHarness,
  key: string,
  overrides: Partial<StateBucketSpec<StateStoreContractMigratedDoc, StateStoreContractMigratedDoc>> = {},
): StateBucketSpec<StateStoreContractMigratedDoc, StateStoreContractMigratedDoc> => ({
  root: { path: harness.root },
  key,
  schema: StateStoreContractMigratedDoc,
  version: 2,
  ...overrides,
});

const encodeStateStoreContractLine = (value: StateStoreContractLine): string => `LANDO-RAW\n${value.value}\n`;

const stateStoreLineSpec = (
  harness: StateStoreContractHarness,
  key: string,
): StateBucketSpec<StateStoreContractLine, StateStoreContractLine> => ({
  root: { path: harness.root },
  key,
  schema: StateStoreContractLine,
  version: 1,
  codec: {
    encode: encodeStateStoreContractLine,
    decode: (raw) => ({ value: decodeUtf8(raw).split("\n")[1] ?? "" }),
  },
});

const stateStoreJsonEnvelopeBytes = (version: number, data: unknown): Uint8Array =>
  utf8(`${JSON.stringify({ version, data }, null, 2)}\n`);

const stateStoreDirname = (file: AbsolutePath): AbsolutePath =>
  Schema.decodeUnknownSync(AbsolutePath)(dirname(file));

const stateStoreRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const requireStateStoreRaw = (
  raw: Uint8Array | null,
  assertion: string,
): Effect.Effect<Uint8Array, ContractFailure> =>
  raw === null ? Effect.fail(stateStoreContractFailure(assertion, raw)) : Effect.succeed(raw);

const parseStateStoreJson = (raw: Uint8Array, assertion: string): Effect.Effect<unknown, ContractFailure> =>
  Effect.try({
    try: () => JSON.parse(decodeUtf8(raw)) as unknown,
    catch: (cause) => stateStoreContractFailure(assertion, cause),
  });

const stateStoreContractCauseFailure = (assertion: string, cause: Cause.Cause<unknown>): ContractFailure => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return failure.value instanceof ContractFailure
      ? failure.value
      : stateStoreContractFailure(assertion, failure.value);
  }
  return stateStoreContractFailure(assertion, Cause.pretty(cause));
};

/**
 * Run the `StateStore` contract assertions against a harness. Asserts (in
 * order): json, binary, and custom codec round-trips plus observable framing;
 * successful `set` leaves no temp file and fully replaces prior content;
 * version-mismatch `discard` and migrator behavior; corruption quarantine and
 * fail behavior; key/namespace containment rejection; and advisory-lock
 * concurrent update serialization plus optional stale lock takeover.
 */
export const runStateStoreContract = (
  harness: StateStoreContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const store = harness.store;
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        stateStoreContractFailure(assertion, cause);

    // 1. Codec round-trip: json, binary, and custom raw codec.
    const jsonBucket = yield* store
      .open(stateStoreDocSpec(harness, "codec-json.json"))
      .pipe(Effect.mapError(failWith("open resolves for a json bucket")));
    yield* jsonBucket.set({ count: 3, label: "json" }).pipe(Effect.mapError(failWith("json set resolves")));
    const jsonValue = yield* jsonBucket.get.pipe(Effect.mapError(failWith("json get resolves")));
    yield* requireStateStoreContract(
      jsonValue?.count === 3 && jsonValue.label === "json",
      "json codec set/get round-trips a schema value",
      jsonValue,
    );
    const jsonRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(jsonBucket.path),
      "json codec writes a file",
    );
    const jsonEnvelope = stateStoreRecord(
      yield* parseStateStoreJson(jsonRaw, "json codec writes a parseable envelope"),
    );
    const jsonEnvelopeData = stateStoreRecord(jsonEnvelope?.data);
    yield* requireStateStoreContract(
      jsonEnvelope?.version === 1 && jsonEnvelopeData?.count === 3 && jsonEnvelopeData.label === "json",
      "json codec writes a { version, data } envelope",
      jsonEnvelope,
    );

    const binaryBucket = yield* store
      .open(stateStoreDocSpec(harness, "codec-binary.bin", { codec: "binary" }))
      .pipe(Effect.mapError(failWith("open resolves for a binary bucket")));
    yield* binaryBucket
      .set({ count: 4, label: "binary" })
      .pipe(Effect.mapError(failWith("binary set resolves")));
    const binaryValue = yield* binaryBucket.get.pipe(Effect.mapError(failWith("binary get resolves")));
    yield* requireStateStoreContract(
      binaryValue?.count === 4 && binaryValue.label === "binary",
      "binary codec set/get round-trips a schema value",
      binaryValue,
    );
    const binaryRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(binaryBucket.path),
      "binary codec writes a file",
    );
    yield* requireStateStoreContract(
      binaryRaw.byteLength >= 8 &&
        binaryRaw[0] === 0x4c &&
        binaryRaw[1] === 0x53 &&
        binaryRaw[2] === 0x42 &&
        binaryRaw[3] === 0x31,
      "binary codec writes the LSB1 magic header",
      Array.from(binaryRaw.slice(0, 4)),
    );
    const binaryVersion = new DataView(binaryRaw.buffer, binaryRaw.byteOffset + 4, 4).getUint32(0, false);
    const binaryEnvelopeData = stateStoreRecord(
      yield* parseStateStoreJson(binaryRaw.slice(8), "binary codec writes a JSON payload"),
    );
    yield* requireStateStoreContract(
      binaryVersion === 1 && binaryEnvelopeData?.count === 4 && binaryEnvelopeData.label === "binary",
      "binary codec writes a versioned JSON body after the magic header",
      { version: binaryVersion, data: binaryEnvelopeData },
    );

    const customBucket = yield* store
      .open(stateStoreLineSpec(harness, "codec-custom.raw"))
      .pipe(Effect.mapError(failWith("open resolves for a custom-codec bucket")));
    yield* customBucket.set({ value: "custom" }).pipe(Effect.mapError(failWith("custom-codec set resolves")));
    const customValue = yield* customBucket.get.pipe(Effect.mapError(failWith("custom-codec get resolves")));
    yield* requireStateStoreContract(
      customValue?.value === "custom",
      "custom codec set/get round-trips a decoded value",
      customValue,
    );
    const customRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(customBucket.path),
      "custom codec writes a file",
    );
    yield* requireStateStoreContract(
      bytesEqual(customRaw, utf8(encodeStateStoreContractLine({ value: "custom" }))),
      "custom codec writes the raw encode() bytes without a frame",
      decodeUtf8(customRaw),
    );

    // 2. Atomic replace: no temp leftovers and replacement is complete.
    const atomicBucket = yield* store
      .open(stateStoreDocSpec(harness, "atomic.json"))
      .pipe(Effect.mapError(failWith("open resolves for an atomic bucket")));
    yield* atomicBucket
      .set({ count: 1, label: "old" })
      .pipe(Effect.mapError(failWith("atomic first set resolves")));
    yield* atomicBucket
      .set({ count: 2, label: "new" })
      .pipe(Effect.mapError(failWith("atomic replacement set resolves")));
    const atomicEntries = yield* harness.list(stateStoreDirname(atomicBucket.path));
    yield* requireStateStoreContract(
      atomicEntries.every((entry) => !entry.includes(".tmp-")),
      "a successful set leaves no *.tmp-* file behind",
      atomicEntries,
    );
    const atomicRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(atomicBucket.path),
      "atomic replacement writes the destination file",
    );
    const atomicEnvelope = stateStoreRecord(
      yield* parseStateStoreJson(atomicRaw, "atomic replacement leaves a complete JSON envelope"),
    );
    const atomicData = stateStoreRecord(atomicEnvelope?.data);
    yield* requireStateStoreContract(
      atomicEnvelope?.version === 1 && atomicData?.count === 2 && atomicData.label === "new",
      "a replacement set fully replaces the prior value",
      atomicEnvelope,
    );

    // 3. Version mismatch: discard returns default; migrator receives raw data and source version.
    const discardSeed = yield* store
      .open(stateStoreDocSpec(harness, "version-discard.json"))
      .pipe(Effect.mapError(failWith("open resolves for the discard seed bucket")));
    yield* harness.writeRaw(discardSeed.path, stateStoreJsonEnvelopeBytes(1, { count: 1, label: "old" }));
    const discardBucket = yield* store
      .open(
        stateStoreDocSpec(harness, "version-discard.json", {
          version: 2,
          onVersionMismatch: "discard",
          default: { count: 0, label: "default" },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for version discard")));
    const discarded = yield* discardBucket.get.pipe(
      Effect.mapError(failWith("version discard get resolves")),
    );
    yield* requireStateStoreContract(
      discarded?.count === 0 && discarded.label === "default",
      "onVersionMismatch discard returns the declared default",
      discarded,
    );

    const migrateSeed = yield* store
      .open(stateStoreMigratedDocSpec(harness, "version-migrate.json", { version: 1 }))
      .pipe(Effect.mapError(failWith("open resolves for the migrate seed bucket")));
    yield* harness.writeRaw(migrateSeed.path, stateStoreJsonEnvelopeBytes(1, { n: 4 }));
    const migrateBucket = yield* store
      .open(
        stateStoreMigratedDocSpec(harness, "version-migrate.json", {
          version: 2,
          onVersionMismatch: (raw, fromVersion) => {
            const legacy = Schema.decodeUnknownSync(StateStoreContractLegacyDoc)(raw);
            return { count: legacy.n, label: "migrated", from: fromVersion };
          },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for version migration")));
    const migrated = yield* migrateBucket.get.pipe(
      Effect.mapError(failWith("version migrator get resolves")),
    );
    yield* requireStateStoreContract(
      migrated?.count === 4 && migrated.label === "migrated" && migrated.from === 1,
      "a StateMigrator receives the raw payload and source version",
      migrated,
    );

    // 4. Corruption handling: quarantine sidecar and fail mode.
    const quarantineSeed = yield* store
      .open(stateStoreDocSpec(harness, "corrupt-quarantine.json"))
      .pipe(Effect.mapError(failWith("open resolves for the quarantine seed bucket")));
    yield* harness.writeRaw(quarantineSeed.path, "{ this is not json");
    const quarantineBucket = yield* store
      .open(
        stateStoreDocSpec(harness, "corrupt-quarantine.json", {
          onCorrupt: "quarantine",
          default: { count: 9, label: "quarantined" },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for corruption quarantine")));
    const quarantined = yield* quarantineBucket.get.pipe(
      Effect.mapError(failWith("corruption quarantine get resolves")),
    );
    yield* requireStateStoreContract(
      quarantined?.count === 9 && quarantined.label === "quarantined",
      "onCorrupt quarantine returns the declared default",
      quarantined,
    );
    const quarantineEntries = yield* harness.list(stateStoreDirname(quarantineBucket.path));
    yield* requireStateStoreContract(
      quarantineEntries.some((entry) => entry.startsWith("corrupt-quarantine.json.corrupt-")) &&
        !quarantineEntries.includes("corrupt-quarantine.json"),
      "onCorrupt quarantine renames the bad file to a sidecar and removes the original key",
      quarantineEntries,
    );

    const corruptFailSeed = yield* store
      .open(stateStoreDocSpec(harness, "corrupt-fail.json"))
      .pipe(Effect.mapError(failWith("open resolves for the fail seed bucket")));
    yield* harness.writeRaw(corruptFailSeed.path, "not-json-at-all");
    const corruptFailBucket = yield* store
      .open(stateStoreDocSpec(harness, "corrupt-fail.json", { onCorrupt: "fail" }))
      .pipe(Effect.mapError(failWith("open resolves for corruption fail mode")));
    const corruptFail = yield* Effect.either(corruptFailBucket.get);
    yield* requireStateStoreContract(
      Either.isLeft(corruptFail) &&
        corruptFail.left instanceof StateStoreError &&
        corruptFail.left.reason === "decode" &&
        corruptFail.left.operation === "get",
      'onCorrupt "fail" surfaces a StateStoreError with reason decode',
      corruptFail,
    );

    // 5. Path containment: reject escaping key and namespace during open.
    const keyEscape = yield* Effect.either(store.open(stateStoreDocSpec(harness, "../escape.json")));
    yield* requireStateStoreContract(
      Either.isLeft(keyEscape) && keyEscape.left.reason === "path" && keyEscape.left.operation === "open",
      "a key escaping the state root is rejected with reason path",
      keyEscape,
    );
    const namespaceEscape = yield* Effect.either(
      store.open(stateStoreDocSpec(harness, "inside.json", { namespace: "../up" })),
    );
    yield* requireStateStoreContract(
      Either.isLeft(namespaceEscape) &&
        namespaceEscape.left.reason === "path" &&
        namespaceEscape.left.operation === "open",
      "a namespace escaping the state root is rejected with reason path",
      namespaceEscape,
    );

    // 6. Advisory lock: concurrent updates serialize; stale lock takeover is optional.
    const lockedBucket = yield* store
      .open(
        stateStoreDocSpec(harness, "locked.json", {
          lock: "advisory",
          default: { count: 0, label: "locked" },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for an advisory bucket")));
    yield* Effect.all(
      Array.from({ length: 20 }, () =>
        lockedBucket
          .update((cur) => ({ count: (cur?.count ?? 0) + 1, label: "locked" }))
          .pipe(Effect.mapError(failWith("advisory update resolves"))),
      ),
      { concurrency: "unbounded" },
    );
    const locked = yield* lockedBucket.get.pipe(Effect.mapError(failWith("advisory final get resolves")));
    yield* requireStateStoreContract(
      locked?.count === 20,
      "an advisory bucket serializes concurrent updates without lost writes",
      locked,
    );
    if (harness.plantStaleLock !== undefined) {
      yield* harness.plantStaleLock(lockedBucket.path);
      const afterStale = yield* lockedBucket
        .update((cur) => ({ count: (cur?.count ?? 0) + 1, label: "locked" }))
        .pipe(Effect.mapError(failWith("advisory stale-lock takeover update resolves")));
      yield* requireStateStoreContract(
        afterStale.count === 21,
        "an advisory bucket takes over a stale lock and completes the update",
        afterStale,
      );
    }
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.fail(stateStoreContractCauseFailure("StateStore contract completes without defects", cause)),
    ),
  );

const downloaderContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Downloader contract failed: ${assertion}`, assertion, details });

const requireDownloaderContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(downloaderContractFailure(assertion, details));

const sha256HexDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const downloaderErrorLeft = (value: unknown): { readonly _tag?: string; readonly reason?: string } =>
  value as { readonly _tag?: string; readonly reason?: string };

/**
 * The harness a `Downloader` implementation provides so one suite can run
 * against `DownloaderLive`, `TestDownloader`, or a plugin-contributed
 * downloader. `tempDir` is the destination directory the suite writes into;
 * `read`/`listDir` are relative to it. `serveSource` registers the bytes a
 * source URL resolves to. The optional `egress` hooks expose the byte/call
 * accounting needed to assert the egress fence (every byte flows through the
 * resolved `HttpClient`); omit them for a downloader with no observable egress.
 */
export interface DownloaderContractHarness {
  readonly name?: string;
  readonly service: DownloaderShape;
  readonly tempDir: AbsolutePath;
  readonly serveSource: (url: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly read: (filename: string) => Effect.Effect<Uint8Array | null>;
  readonly listDir: () => Effect.Effect<ReadonlyArray<string>>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly egress?: {
    readonly streamCallCount: () => Effect.Effect<number>;
    readonly bytesStreamed: () => Effect.Effect<number>;
  };
}

/**
 * Run the `Downloader` contract assertions against a harness. Asserts (in
 * order): capability declaration; a verified `https://` download streams fresh
 * bytes and returns sha256+size (`fromCache:false`); an identical re-request is
 * served from the verified cache with no egress; `offline` + uncached fails
 * with `DownloadOfflineError` and issues no egress; a checksum mismatch is
 * rejected; a size mismatch is rejected; `http://` and bare `file://` sources
 * are rejected; a destination filename escaping the directory is rejected; a
 * successful file download leaves no temp file (atomic rename); an interrupted
 * file download leaves no temp file and the destination fully absent or fully
 * complete (never torn); lifecycle events are published and a secret in the URL
 * query / userinfo / caller fields never appears in any event; and (when the
 * harness exposes egress) a network miss issues exactly one stream call whose
 * byte count equals the downloaded size.
 */
export const runDownloaderContract = (
  harness: DownloaderContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const download = (
      request: Parameters<DownloaderShape["download"]>[0],
    ): Effect.Effect<DownloadResult, unknown> => Effect.scoped(service.download(request));
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        downloaderContractFailure(assertion, cause);
    const dir = harness.tempDir;

    yield* requireDownloaderContract(
      typeof service.id === "string" && service.id.length > 0,
      "the downloader declares a non-empty id",
      service.id,
    );
    yield* requireDownloaderContract(
      Array.isArray(service.capabilities.schemes) && service.capabilities.schemes.includes("https"),
      "capabilities declare the https scheme",
      service.capabilities,
    );

    const payload = new TextEncoder().encode("contract artifact payload");
    const expectedSha256 = sha256HexDigest(payload);
    const okUrl = "https://contract.test/artifact.bin";
    yield* harness.serveSource(okUrl, payload);
    const created = yield* download({
      url: okUrl,
      destination: { kind: "file", directory: dir, filename: "artifact.bin" },
      expectedSha256,
      expectedSizeBytes: payload.length,
      callerId: "contract",
    }).pipe(Effect.mapError(failWith("a verified https download succeeds")));
    yield* requireDownloaderContract(
      created.fromCache === false &&
        created.sha256 === expectedSha256 &&
        created.sizeBytes === payload.length,
      "the first download streams fresh bytes and returns sha256+size",
      created,
    );
    const onDisk = yield* harness.read("artifact.bin");
    yield* requireDownloaderContract(
      onDisk !== null && onDisk.length === payload.length,
      "the verified file is written to the destination",
      onDisk?.length,
    );

    const cacheCallsBefore = harness.egress ? yield* harness.egress.streamCallCount() : 0;
    const cached = yield* download({
      url: okUrl,
      destination: { kind: "file", directory: dir, filename: "artifact.bin" },
      expectedSha256,
      expectedSizeBytes: payload.length,
    }).pipe(Effect.mapError(failWith("a cached re-request resolves")));
    yield* requireDownloaderContract(
      cached.fromCache === true,
      "an identical re-request is served from the verified cache",
      cached,
    );
    if (harness.egress) {
      const cacheCallsAfter = yield* harness.egress.streamCallCount();
      yield* requireDownloaderContract(cacheCallsAfter === cacheCallsBefore, "a cache hit issues no egress", {
        cacheCallsBefore,
        cacheCallsAfter,
      });
    }

    const offlineUrl = "https://contract.test/offline.bin";
    yield* harness.serveSource(offlineUrl, payload);
    const offlineCallsBefore = harness.egress ? yield* harness.egress.streamCallCount() : 0;
    const offlineResult = yield* Effect.either(
      download({
        url: offlineUrl,
        destination: { kind: "file", directory: dir, filename: "offline.bin" },
        expectedSha256,
        offline: true,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(offlineResult) && downloaderErrorLeft(offlineResult.left)._tag === "DownloadOfflineError",
      "offline + uncached fails with DownloadOfflineError",
      offlineResult,
    );
    if (harness.egress) {
      const offlineCallsAfter = yield* harness.egress.streamCallCount();
      yield* requireDownloaderContract(
        offlineCallsAfter === offlineCallsBefore,
        "an offline cache miss issues no egress",
        { offlineCallsBefore, offlineCallsAfter },
      );
    }

    const checksumUrl = "https://contract.test/checksum.bin";
    yield* harness.serveSource(checksumUrl, payload);
    const checksumResult = yield* Effect.either(
      download({
        url: checksumUrl,
        destination: { kind: "memory" },
        expectedSha256: "a".repeat(64),
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(checksumResult) &&
        downloaderErrorLeft(checksumResult.left)._tag === "DownloadChecksumError",
      "a checksum mismatch is rejected with DownloadChecksumError",
      checksumResult,
    );

    const sizeUrl = "https://contract.test/size.bin";
    yield* harness.serveSource(sizeUrl, payload);
    const sizeResult = yield* Effect.either(
      download({
        url: sizeUrl,
        destination: { kind: "memory" },
        expectedSizeBytes: payload.length + 1,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(sizeResult) && downloaderErrorLeft(sizeResult.left)._tag === "DownloadSizeMismatchError",
      "a size mismatch is rejected with DownloadSizeMismatchError",
      sizeResult,
    );

    const schemeResult = yield* Effect.either(
      download({ url: "http://contract.test/insecure.bin", destination: { kind: "memory" } }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(schemeResult) &&
        downloaderErrorLeft(schemeResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(schemeResult.left).reason === "scheme",
      "an http:// source is rejected with reason scheme",
      schemeResult,
    );

    const fileResult = yield* Effect.either(
      download({ url: "file:///tmp/contract.bin", destination: { kind: "memory" } }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(fileResult) &&
        downloaderErrorLeft(fileResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(fileResult.left).reason === "file-source",
      "a bare file:// source is rejected with reason file-source",
      fileResult,
    );

    const escapeResult = yield* Effect.either(
      download({
        url: okUrl,
        destination: { kind: "file", directory: dir, filename: "../escape.bin" },
        expectedSha256,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(escapeResult) &&
        downloaderErrorLeft(escapeResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(escapeResult.left).reason === "destination-escape",
      "a destination filename escaping the directory is rejected",
      escapeResult,
    );

    const afterSuccess = yield* harness.listDir();
    yield* requireDownloaderContract(
      afterSuccess.includes("artifact.bin") && !afterSuccess.some((f) => f.includes(".tmp-")),
      "a successful download leaves the destination and no temp file",
      afterSuccess,
    );

    const interruptUrl = "https://contract.test/interrupt.bin";
    yield* harness.serveSource(interruptUrl, payload);
    const fiber = yield* Effect.fork(
      download({
        url: interruptUrl,
        destination: { kind: "file", directory: dir, filename: "interrupt.bin" },
        expectedSha256,
      }),
    );
    yield* Fiber.interrupt(fiber);
    const afterInterrupt = yield* harness.listDir();
    yield* requireDownloaderContract(
      !afterInterrupt.some((f) => f.includes(".tmp-")),
      "an interrupted download leaves no temp file",
      afterInterrupt,
    );
    const interruptedFile = yield* harness.read("interrupt.bin");
    yield* requireDownloaderContract(
      interruptedFile === null || interruptedFile.length === payload.length,
      "an interrupted download leaves the destination absent or complete, never torn",
      interruptedFile?.length,
    );

    const secret = "ULW-DLC-SECRET-d41d8cd9f00b2";
    const secretUrl = `https://user:${secret}@contract.test/s?token=${secret}`;
    yield* harness.serveSource(secretUrl, payload);
    yield* download({
      url: secretUrl,
      destination: { kind: "memory" },
      expectedSha256,
      callerId: `caller-${secret}`,
      redactionTokens: [secret],
    }).pipe(Effect.mapError(failWith("a secret-bearing download succeeds")));
    const events = yield* harness.events();
    yield* requireDownloaderContract(
      events.some((e) => e._tag === "pre-download") && events.some((e) => e._tag === "post-download"),
      "pre-download and post-download events are published",
      events.map((e) => e._tag),
    );
    yield* requireDownloaderContract(
      !JSON.stringify(events).includes(secret),
      "a secret in the URL query / userinfo / caller fields never appears in an event",
      { sample: events[0] },
    );

    if (harness.egress) {
      const egressUrl = "https://contract.test/egress.bin";
      yield* harness.serveSource(egressUrl, payload);
      const callsBefore = yield* harness.egress.streamCallCount();
      const bytesBefore = yield* harness.egress.bytesStreamed();
      const egressResult = yield* download({
        url: egressUrl,
        destination: { kind: "memory" },
        expectedSha256,
      }).pipe(Effect.mapError(failWith("an egress-observed download succeeds")));
      const callsAfter = yield* harness.egress.streamCallCount();
      const bytesAfter = yield* harness.egress.bytesStreamed();
      yield* requireDownloaderContract(
        callsAfter - callsBefore === 1,
        "a network miss issues exactly one egress stream call",
        { callsBefore, callsAfter },
      );
      yield* requireDownloaderContract(
        bytesAfter - bytesBefore === egressResult.sizeBytes,
        "every downloaded byte flows through the resolved HttpClient",
        { bytesBefore, bytesAfter, sizeBytes: egressResult.sizeBytes },
      );
    }
  });

const interactionContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `InteractionService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireInteractionContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(interactionContractFailure(assertion, details));

type RendererServiceShape = Context.Tag.Service<typeof Renderer>;

/**
 * Capturing renderer used by the contract to prove prompt chrome routes
 * through `Renderer.output.stdout` instead of a direct stdio write.
 */
export interface InteractionContractRenderer {
  readonly service: RendererServiceShape;
  readonly stdout: () => string;
}

/** Build a capturing renderer the harness can inject for the routing assertion. */
export const makeInteractionContractRenderer = (id = "plain"): InteractionContractRenderer => {
  let out = "";
  return {
    stdout: () => out,
    service: {
      id,
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: {
        stdout: (chunk: string) =>
          Effect.sync(() => {
            out += chunk;
          }),
        stderr: () => Effect.void,
      },
    },
  };
};

/**
 * Description of one interaction service instance the harness must construct.
 * The caller wires the real construction deps (scripted/never stdin, a capturing
 * stdout, an optional renderer, an optional dynamic-choices runner) so the
 * contract drives only the published `InteractionServiceShape` methods.
 */
export interface InteractionServiceSpec {
  /** Lines the service should read for interactive prompts, in order. */
  readonly scriptedInput?: ReadonlyArray<string>;
  /** When true, the service must use a stdin that is never read (proves fail-fast). */
  readonly neverStdin?: boolean;
  /** When true, the service's stdin reports `isTTY: true`. */
  readonly tty?: boolean;
  /** Stdout sink the service writes prompt chrome to when no renderer is present. */
  readonly stdout?: (chunk: string) => void;
  /** Renderer to provide to the service effect (routing assertion). */
  readonly renderer?: RendererServiceShape;
  /** Dynamic-choices command result for `choicesFrom` prompts. */
  readonly choicesResult?: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}

/**
 * Harness for {@link runInteractionContract}.
 *
 * `makeService` builds an `InteractionServiceShape` from a {@link InteractionServiceSpec}.
 * The Live caller wires `makeInteractionService` with scripted IO; the test-double
 * caller wires `makeTestInteractionService`. Capability flags gate assertions that
 * a given implementation can satisfy (e.g. a non-stdin test double cannot exercise
 * the interrupt/TTY-restore path).
 */
export interface InteractionContractHarness {
  readonly name?: string;
  readonly makeService: (spec: InteractionServiceSpec) => InteractionServiceShape;
  /** Declared capabilities (mirrors `InteractionServiceContribution.capabilities`). */
  readonly capabilities: {
    readonly interactive: boolean;
    readonly promptTypes: ReadonlyArray<PromptType>;
    readonly secretRedaction: boolean;
  };
  /**
   * When true, the suite exercises interactive stdin reading: prompt chrome
   * routing through `Renderer.output` and (with {@link supportsInterruption})
   * the cancellation path. A non-interactive-only implementation (e.g. a
   * terminal-free test double) declares this `false`.
   */
  readonly supportsInteractiveInput?: boolean;
  /** When true, the suite exercises external `Effect.interrupt` -> cancellation + TTY restore. */
  readonly supportsInterruption?: boolean;
  /** When true, the suite exercises dynamic `choicesFrom` resolution + manual fallback. */
  readonly supportsDynamicChoices?: boolean;
}

const interactionTextPrompt = (name: string, message = "Value?"): PromptSpec => ({
  name,
  type: "text",
  message,
});

const runInteractionScoped = <A>(
  effect: Effect.Effect<A, InteractionError, Scope.Scope>,
): Effect.Effect<Exit.Exit<A, InteractionError>> => Effect.exit(Effect.scoped(effect));

const interactionFailureTag = <A>(exit: Exit.Exit<A, InteractionError>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined;
};

/**
 * Run the `InteractionService` contract assertions against a harness. Asserts (in
 * order): capability declaration; answer-source precedence (explicit answer wins
 * over default and over reading input); `auto`-mode TTY gating (non-TTY resolves
 * non-interactively); non-interactive fail-fast with `InteractionRequiredError`
 * and no stdin read; per-type validation (`number` rejects a non-numeric default);
 * `secret` non-echo + `Redacted` carriage; prompt output routes through
 * `Renderer.output.stdout` when a renderer is present; and (when the harness
 * declares support) external `Effect.interrupt` surfaces `InteractionCancelledError`
 * with TTY raw-mode restored, plus dynamic `choicesFrom` resolution and the
 * `InteractionRequiredError` manual fallback when choices cannot resolve
 * non-interactively.
 */
export const runInteractionContract = (
  harness: InteractionContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireInteractionContract(
      typeof harness.capabilities.interactive === "boolean" &&
        Array.isArray(harness.capabilities.promptTypes) &&
        harness.capabilities.promptTypes.length > 0 &&
        typeof harness.capabilities.secretRedaction === "boolean",
      "the harness declares interaction capabilities (interactive, promptTypes, secretRedaction)",
      harness.capabilities,
    );

    const idService = harness.makeService({ neverStdin: true });
    yield* requireInteractionContract(
      typeof idService.id === "string" && idService.id.length > 0,
      "the interaction service declares a non-empty id",
      idService.id,
    );

    const precedenceService = harness.makeService({ neverStdin: true });
    const precedenceExit = yield* runInteractionScoped(
      precedenceService.promptAll([interactionTextPrompt("app")], {
        answers: { app: "explicit" },
        mode: "non-interactive",
      }),
    );
    yield* requireInteractionContract(
      Exit.isSuccess(precedenceExit) && (precedenceExit.value as Record<string, unknown>).app === "explicit",
      "an explicit answer wins over prompting and over the default",
      precedenceExit,
    );

    const defaultService = harness.makeService({ neverStdin: true });
    const defaultExit = yield* runInteractionScoped(
      defaultService.promptAll([{ name: "app", type: "text", message: "Name?", default: "fallback" }], {
        yes: true,
      }),
    );
    yield* requireInteractionContract(
      Exit.isSuccess(defaultExit) && (defaultExit.value as Record<string, unknown>).app === "fallback",
      "--yes resolves a prompt default without reading input",
      defaultExit,
    );

    const nonTtyService = harness.makeService({ neverStdin: true });
    const isInteractive = yield* nonTtyService.isInteractive;
    yield* requireInteractionContract(
      isInteractive === false,
      "auto mode reports non-interactive when stdin is not a TTY",
      isInteractive,
    );
    const autoExit = yield* runInteractionScoped(
      nonTtyService.promptAll([interactionTextPrompt("app")], { mode: "auto" }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(autoExit) === "InteractionRequiredError",
      "auto-mode TTY gating fails fast on a non-TTY when no answer is supplied",
      autoExit,
    );

    const failFastService = harness.makeService({ neverStdin: true });
    // Against a never-readable stdin this resolves only if the service fails fast
    // instead of blocking on a read; a short timeout converts a hang into a
    // contract failure rather than a hung test.
    const failFastExit = yield* runInteractionScoped(
      failFastService.promptAll([interactionTextPrompt("app")], { mode: "non-interactive" }),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(5),
        onTimeout: () => interactionContractFailure("non-interactive resolution never blocks on stdin"),
      }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(failFastExit) === "InteractionRequiredError",
      "non-interactive resolution fails fast with InteractionRequiredError",
      failFastExit,
    );

    const validationService = harness.makeService({ neverStdin: true });
    const validationExit = yield* runInteractionScoped(
      validationService.promptAll([{ name: "port", type: "number", message: "Port?" }], {
        answers: { port: "not-a-number" },
        mode: "non-interactive",
      }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(validationExit) === "PromptValidationError",
      "an invalid answer for a typed prompt fails with PromptValidationError",
      validationExit,
    );

    if (harness.capabilities.secretRedaction) {
      const secretService = harness.makeService({
        scriptedInput: ["hunter2"],
        tty: true,
      });
      const secretExit = yield* runInteractionScoped(
        secretService.secret({ name: "token", message: "Token?", answers: { token: "hunter2" } }),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(secretExit) && Redacted.value(secretExit.value) === "hunter2",
        "secret answers are carried as Redacted values",
        secretExit,
      );
      yield* requireInteractionContract(
        Exit.isSuccess(secretExit) &&
          !String(secretExit.value).includes("hunter2") &&
          !JSON.stringify(secretExit.value).includes("hunter2"),
        "a secret value never appears in its string or JSON representation",
        secretExit,
      );
    }

    if (harness.supportsInteractiveInput === true) {
      const renderer = makeInteractionContractRenderer();
      const routedService = harness.makeService({
        scriptedInput: ["routed-value"],
        tty: true,
        renderer: renderer.service,
      });
      const routedExit = yield* runInteractionScoped(
        Effect.provideService(
          routedService.promptAll([{ name: "app", type: "text", message: "RoutedQuestion?" }], {
            mode: "interactive",
          }),
          Renderer,
          renderer.service,
        ),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(routedExit) && renderer.stdout().includes("RoutedQuestion?"),
        "prompt chrome routes through Renderer.output.stdout when a renderer is present",
        { exit: routedExit, captured: renderer.stdout() },
      );
    }

    if (harness.supportsInterruption === true) {
      const interruptService = harness.makeService({ neverStdin: true, tty: true });
      const interruptExit = yield* Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(interruptService.promptAll([interactionTextPrompt("app")], { mode: "interactive" })),
        );
        yield* Effect.sleep("25 millis");
        return yield* Fiber.interrupt(fiber);
      });
      yield* requireInteractionContract(
        interactionFailureTag(interruptExit) === "InteractionCancelledError",
        "external Effect.interrupt surfaces InteractionCancelledError",
        interruptExit,
      );
    }

    if (harness.supportsDynamicChoices === true) {
      const choicesService = harness.makeService({
        neverStdin: true,
        choicesResult: { exitCode: 0, stdout: "8.1\n8.2\n", stderr: "" },
      });
      const choicesExit = yield* runInteractionScoped(
        choicesService.promptAll(
          [
            {
              name: "phpVersion",
              type: "select",
              message: "PHP?",
              choicesFrom: { command: "services:list", parse: "lines" },
            },
          ],
          { answers: { phpVersion: "8.2" }, mode: "non-interactive", runs: ["services:list"] },
        ),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(choicesExit) && (choicesExit.value as Record<string, unknown>).phpVersion === "8.2",
        "a seeded answer resolves a dynamic choicesFrom prompt",
        choicesExit,
      );

      const manualFallbackService = harness.makeService({
        neverStdin: true,
        choicesResult: { exitCode: 0, stdout: "8.1\n8.2\n", stderr: "" },
      });
      const manualExit = yield* runInteractionScoped(
        manualFallbackService.promptAll(
          [
            {
              name: "phpVersion",
              type: "select",
              message: "PHP?",
              choicesFrom: { command: "services:list", parse: "lines" },
            },
          ],
          { mode: "non-interactive", runs: ["services:list"] },
        ),
      );
      yield* requireInteractionContract(
        interactionFailureTag(manualExit) === "InteractionRequiredError",
        "a resolvable dynamic-choices prompt with no answer fails fast non-interactively",
        manualExit,
      );
    }
  });

// ----- Redaction contract suite -------------------------------------------

const redactionContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `Redaction contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireRedactionContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(redactionContractFailure(assertion, details));

/**
 * A canonical "soup" fixture that exercises every redaction pattern class in a
 * single string. Use this as the input for golden-output assertions in the
 * redaction contract suite.
 *
 * - `text`: one string containing every pattern class.
 * - `registeredSecrets`: literal values to register in the value layer,
 *   including a prefix-pair to prove longest-first ordering and a value that
 *   also matches a bearer-token pattern to prove value-layer-before-pattern.
 * - `value`: a structured object for `redactValue` assertions.
 */
export const SECRET_SOUP_FIXTURE = Object.freeze({
  text: [
    "DB_PASSWORD=hunter2longvalue",
    "https://user:pass@host.example.com/path",
    "Authorization: Bearer abc.def.ghijklmnop",
    "?token=deadbeefsecret&api_key=anotherapikeyvalue",
    "/home/alice/projects/app",
    "C:\\Users\\alice\\AppData\\Local\\Temp\\x",
    "\\\\fileserver\\share\\secret",
    "~/.config/lando/config.yml",
    "abc123def456",
    "123e4567-e89b-12d3-a456-426614174000",
    "sha256:aabbccddee112233445566778899aabbccddee112233445566778899aabbccdd",
    "superSecretTokenLongerSuffix",
    ":54321",
    "myapp_web_ab12cd34",
  ].join(" "),

  /**
   * Literal secret values for the value layer.
   * - "superSecretToken" / "superSecretTokenLongerSuffix": prefix-pair proving longest-first.
   * - "abc.def.ghijklmnop": also matches the bearer-token pattern, proving value-layer-before-pattern.
   */
  registeredSecrets: Object.freeze([
    "hunter2longvalue",
    "superSecretToken",
    "superSecretTokenLongerSuffix",
    "abc.def.ghijklmnop",
  ] as ReadonlyArray<string>),

  /**
   * A structured value for `redactValue` assertions: nested object with
   * secret-keyed fields, an array, an Error, a cyclic reference, and a plain
   * string field containing a soup substring.
   */
  get value(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      username: "alice",
      password: "hunter2longvalue",
      token: "abc.def.ghijklmnop",
      tags: ["prod", "hunter2longvalue"],
      nested: { api_key: "anotherapikeyvalue", host: "host.example.com" },
      err: new Error("connect failed: hunter2longvalue"),
      note: "see /home/alice/projects/app for details",
    };
    // cyclic reference
    (obj as Record<string, unknown>).self = obj;
    return obj;
  },
} as const);

/**
 * Harness for {@link runRedactionContract}.
 *
 * - `name`: optional label for error messages.
 * - `makeRedactor`: factory that builds a {@link Redactor} for the given
 *   profile and options. Must be the real `createRedactor` or a conforming
 *   implementation.
 * - `golden`: per-profile expected output of
 *   `makeRedactor(profile, { values: SECRET_SOUP_FIXTURE.registeredSecrets, env })
 *    .redactString(SECRET_SOUP_FIXTURE.text)`.
 * - `goldenValue`: optional per-profile expected output of `redactValue`.
 */
export interface RedactionContractHarness {
  readonly name?: string;
  readonly makeRedactor: (profile: RedactionProfile, options?: CreateRedactorOptions) => Redactor;
  readonly golden: Record<RedactionProfile, { readonly string: string }>;
  readonly goldenValue?: Record<RedactionProfile, unknown>;
}

/**
 * Run the redaction contract assertions against a harness. Asserts (in order):
 * - byte-identical golden output per profile.
 * - value-layer-before-pattern: a registered literal that also matches a
 *   bearer-token pattern is masked to the value sentinel with no raw remnant.
 * - longest-first: with the prefix-pair registered, redacting a string
 *   containing the longer value leaves no residue of the shorter value.
 * - structure-preserving `redactValue`: arrays stay arrays, objects keep keys,
 *   Error becomes `{name, message}`, cycles become `"[circular]"`, and
 *   secret-keyed fields are masked.
 * - idempotence: `redactString(redactString(t)) === redactString(t)` on a
 *   bearer-token-only text (which is idempotent for all three profiles).
 */
export const runRedactionContract = (
  harness: RedactionContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? "redactor";
    const env: TranscriptRedactionEnv = {
      home: "/home/alice",
      tmp: "/tmp",
      user: "alice",
      host: "host.example.com",
    };
    const profiles: ReadonlyArray<RedactionProfile> = ["secrets", "telemetry", "transcript"];

    // --- golden output per profile ---
    for (const profile of profiles) {
      const r = harness.makeRedactor(profile, {
        values: SECRET_SOUP_FIXTURE.registeredSecrets,
        env,
      });
      const actual = r.redactString(SECRET_SOUP_FIXTURE.text);
      const expected = harness.golden[profile].string;
      yield* requireRedactionContract(
        actual === expected,
        `${label} ${profile} profile produces the expected golden output`,
        { actual, expected },
      );
    }

    // --- value-layer-before-pattern ---
    // "abc.def.ghijklmnop" is both a registered secret AND matches the bearer-token
    // pattern. The value layer must mask it first so no raw remnant survives.
    const bearerText = "Authorization: Bearer abc.def.ghijklmnop";
    const bearerR = harness.makeRedactor("secrets", {
      values: SECRET_SOUP_FIXTURE.registeredSecrets,
    });
    const bearerResult = bearerR.redactString(bearerText);
    yield* requireRedactionContract(
      !bearerResult.includes("abc.def.ghijklmnop"),
      "value-layer-before-pattern: registered bearer value leaves no raw remnant",
      { input: bearerText, output: bearerResult },
    );

    // --- longest-first ---
    // With both "superSecretToken" and "superSecretTokenLongerSuffix" registered,
    // a string containing the longer value must be fully masked (no shorter residue).
    const longerText = "superSecretTokenLongerSuffix is the full value";
    const longestR = harness.makeRedactor("secrets", {
      values: SECRET_SOUP_FIXTURE.registeredSecrets,
    });
    const longestResult = longestR.redactString(longerText);
    yield* requireRedactionContract(
      !longestResult.includes("superSecretToken"),
      "longest-first: longer registered value is masked before shorter prefix",
      { input: longerText, output: longestResult },
    );

    // --- structure-preserving redactValue ---
    const valueR = harness.makeRedactor("secrets", {
      values: SECRET_SOUP_FIXTURE.registeredSecrets,
    });
    const redacted = valueR.redactValue(SECRET_SOUP_FIXTURE.value) as Record<string, unknown>;

    yield* requireRedactionContract(
      Array.isArray(redacted.tags),
      "redactValue preserves arrays as arrays",
      redacted.tags,
    );
    yield* requireRedactionContract(
      typeof redacted.nested === "object" &&
        redacted.nested !== null &&
        "api_key" in (redacted.nested as object),
      "redactValue preserves object keys",
      redacted.nested,
    );
    yield* requireRedactionContract(
      typeof redacted.err === "object" &&
        redacted.err !== null &&
        "name" in (redacted.err as object) &&
        "message" in (redacted.err as object),
      "redactValue converts Error to {name, message}",
      redacted.err,
    );
    yield* requireRedactionContract(
      redacted.self === "[circular]",
      "redactValue returns [circular] for cyclic references",
      redacted.self,
    );
    yield* requireRedactionContract(
      redacted.password === "[redacted]",
      "redactValue masks secret-keyed fields",
      redacted.password,
    );
    yield* requireRedactionContract(
      redacted.token === "[redacted]",
      "redactValue masks token-keyed fields",
      redacted.token,
    );

    if (harness.goldenValue !== undefined) {
      for (const profile of profiles) {
        const gvR = harness.makeRedactor(profile, {
          values: SECRET_SOUP_FIXTURE.registeredSecrets,
          env,
        });
        const gvActual = gvR.redactValue(SECRET_SOUP_FIXTURE.value);
        const gvExpected = harness.goldenValue[profile];
        yield* requireRedactionContract(
          JSON.stringify(gvActual) === JSON.stringify(gvExpected),
          `${label} ${profile} profile redactValue matches goldenValue`,
          { actual: gvActual, expected: gvExpected },
        );
      }
    }

    // --- idempotence (bearer-token-only text, idempotent for all profiles) ---
    const idempotenceText = "Authorization: Bearer mytoken123 https://user:pass@host.com/path";
    for (const profile of profiles) {
      const iR = harness.makeRedactor(profile, {
        values: [],
        env: { home: "/home/alice", tmp: "/tmp", user: "alice", host: "host.com" },
      });
      const once = iR.redactString(idempotenceText);
      const twice = iR.redactString(once);
      yield* requireRedactionContract(
        once === twice,
        `${label} ${profile} profile redactString is idempotent on bearer/userinfo text`,
        { once, twice },
      );
    }
  });

// ---------------------------------------------------------------------------
// SecretStore contract suite
// ---------------------------------------------------------------------------

const secretStoreContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `SecretStore contract failed: ${assertion}`, assertion, details });

const requireSecretStoreContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(secretStoreContractFailure(assertion, details));

/**
 * Drives any `SecretStore` implementation (the built-in env store, the
 * in-memory `TestSecretStore`, or a plugin-contributed store) through the
 * published secret-store contract guarantees. `store`, `known`, and `unknown` are required; the
 * remaining fields are optional capability probes that assert the fuller spec
 * guarantee only when the harness supplies the hook, so today's env store stays
 * conformant without backend/auth/offline machinery it does not yet implement.
 */
export interface SecretStoreContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The `SecretStore` implementation under test. */
  readonly store: SecretStoreShape;
  /** A secret id that resolves, plus its expected value. */
  readonly known: { readonly key: string; readonly value: string };
  /** A secret id guaranteed to be absent. */
  readonly unknown: string;
  /**
   * Optional: build a value redactor seeded from the resolved secret so the
   * suite can prove resolved values never survive in rendered output.
   * Accepts the canonical `Redactor` or any `{ redactString }`-shaped value
   * redactor.
   */
  readonly redactor?: (values: ReadonlyArray<string>) => { readonly redactString: (text: string) => string };
  /**
   * Optional: a store whose backend/auth is unavailable. The suite asserts that
   * `get` surfaces a tagged error rather than a generic throw.
   */
  readonly backendFailureStore?: SecretStoreShape;
  /**
   * Optional: a store backed only by an already-cached secret with no live
   * backend. The suite asserts the known secret still resolves offline.
   */
  readonly cachedOfflineStore?: {
    readonly store: SecretStoreShape;
    readonly key: string;
    readonly value: string;
  };
}

export const runSecretStoreContractSuite = (
  harness: SecretStoreContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.store.id;
    const store = harness.store;

    yield* requireSecretStoreContract(
      isNonEmptyString(store.id),
      `${label}: store exposes a non-empty id`,
      store.id,
    );
    yield* requireSecretStoreContract(
      Effect.isEffect(store.get(harness.known.key)),
      `${label}: get is Effect-typed`,
    );
    yield* requireSecretStoreContract(Effect.isEffect(store.list), `${label}: list is Effect-typed`);

    // --- known secret resolves deterministically ---
    const first = yield* store
      .get(harness.known.key)
      .pipe(Effect.mapError((cause) => secretStoreContractFailure(`${label}: get(known) resolves`, cause)));
    yield* requireSecretStoreContract(
      first === harness.known.value,
      `${label}: get(known) returns the expected value`,
      { actual: first, expected: harness.known.value },
    );
    const second = yield* store
      .get(harness.known.key)
      .pipe(
        Effect.mapError((cause) => secretStoreContractFailure(`${label}: repeat get(known) resolves`, cause)),
      );
    yield* requireSecretStoreContract(
      first === second,
      `${label}: get(known) is deterministic across repeats`,
      { first, second },
    );

    const hasKnown = yield* store.has(harness.known.key);
    yield* requireSecretStoreContract(hasKnown === true, `${label}: has(known) is true`, hasKnown);

    const listed = yield* store.list;
    yield* requireSecretStoreContract(
      listed.includes(harness.known.key),
      `${label}: list includes the known secret id`,
      listed,
    );
    const listedAgain = yield* store.list;
    yield* requireSecretStoreContract(
      JSON.stringify(listed) === JSON.stringify(listedAgain),
      `${label}: list is deterministic across repeats`,
      { listed, listedAgain },
    );

    // --- unknown secret fails with the tagged error ---
    const unknownExit = yield* Effect.exit(store.get(harness.unknown));
    yield* requireSecretStoreContract(
      Exit.isFailure(unknownExit),
      `${label}: get(unknown) fails`,
      unknownExit,
    );
    if (Exit.isFailure(unknownExit)) {
      const failure = Cause.failureOption(unknownExit.cause);
      yield* requireSecretStoreContract(
        Option.isSome(failure) && failure.value instanceof SecretNotFoundError,
        `${label}: get(unknown) fails with SecretNotFoundError`,
        unknownExit.cause,
      );
      if (Option.isSome(failure) && failure.value instanceof SecretNotFoundError) {
        yield* requireSecretStoreContract(
          failure.value.secret === harness.unknown,
          `${label}: SecretNotFoundError carries the requested secret id`,
          failure.value,
        );
      }
    }
    const hasUnknown = yield* store.has(harness.unknown);
    yield* requireSecretStoreContract(hasUnknown === false, `${label}: has(unknown) is false`, hasUnknown);

    // --- optional: resolved values register with the canonical redactor ---
    if (harness.redactor) {
      const redactor = harness.redactor([harness.known.value]);
      const redacted = redactor.redactString(`token=${harness.known.value} trailing`);
      yield* requireSecretStoreContract(
        !redacted.includes(harness.known.value),
        `${label}: resolved value is redacted from rendered output`,
        { redacted },
      );
    }

    // --- optional: missing-backend/auth failures surface tagged errors ---
    if (harness.backendFailureStore) {
      const failExit = yield* Effect.exit(harness.backendFailureStore.get(harness.known.key));
      yield* requireSecretStoreContract(
        Exit.isFailure(failExit),
        `${label}: backend/auth failure surfaces a tagged error`,
        failExit,
      );
      if (Exit.isFailure(failExit)) {
        const failure = Cause.failureOption(failExit.cause);
        yield* requireSecretStoreContract(
          Option.isSome(failure) && typeof (failure.value as { _tag?: unknown })._tag === "string",
          `${label}: backend/auth failure is a tagged error (carries _tag)`,
          failExit.cause,
        );
      }
    }

    // --- optional: already-cached secrets resolve offline ---
    if (harness.cachedOfflineStore) {
      const cached = yield* harness.cachedOfflineStore.store
        .get(harness.cachedOfflineStore.key)
        .pipe(
          Effect.mapError((cause) =>
            secretStoreContractFailure(`${label}: cached offline get resolves`, cause),
          ),
        );
      yield* requireSecretStoreContract(
        cached === harness.cachedOfflineStore.value,
        `${label}: already-cached secret resolves offline`,
        { actual: cached, expected: harness.cachedOfflineStore.value },
      );
    }
  });

export const makeSecretStoreContractSuite = runSecretStoreContractSuite;

// ---------------------------------------------------------------------------
// ConfigTranslator contract suite
// ---------------------------------------------------------------------------

const configTranslatorContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ConfigTranslator contract failed: ${assertion}`, assertion, details });

const requireConfigTranslatorContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(configTranslatorContractFailure(assertion, details));

/**
 * Drives any `ConfigTranslator` through the published config-translator contract:
 * `detect()` is authoritative; `translate()` returns a schema-valid
 * `LandofileShape` fragment plus diagnostics (never an `AppPlan`, never a file
 * mutation/provider contact/plugin install); output is deterministic; and the
 * emitted fragment round-trips through the canonical Landofile serializer.
 * `translator` and `matchingInput` are required; the remaining fields
 * are optional probes asserted only when the harness supplies the hook.
 */
export interface ConfigTranslatorContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The translator under test. */
  readonly translator: ConfigTranslatorShape;
  /** An input the translator detects and translates. */
  readonly matchingInput: ConfigTranslateInput;
  /**
   * Optional: an input the translator must NOT detect, proving detection is
   * authoritative (advisory globs alone never force translation).
   */
  readonly nonMatchingInput?: ConfigTranslateInput;
  /** Optional: the exact fragment the translator must emit for `matchingInput`. */
  readonly expectedFragment?: LandofileFragment;
  /**
   * Optional: an options schema and an invalid options value. When supplied the
   * suite asserts invalid options are rejected before `translate` runs.
   */
  readonly optionsSchema?: Schema.Schema<unknown, unknown>;
  /** Optional: an options value that must fail `optionsSchema` decode. */
  readonly invalidOptions?: unknown;
  /**
   * Optional: a snapshot/assert pair proving `translate` performed no external
   * mutation (no file write, provider contact, or plugin install).
   */
  readonly mutationProbe?: {
    readonly snapshot: Effect.Effect<unknown>;
    readonly assertUnchanged: (before: unknown) => Effect.Effect<boolean>;
  };
}

export const runConfigTranslatorContractSuite = (
  harness: ConfigTranslatorContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const translator = harness.translator;
    const label = harness.name ?? translator.id;

    yield* requireConfigTranslatorContract(
      isNonEmptyString(translator.id),
      `${label}: translator exposes a non-empty id`,
      translator.id,
    );
    yield* requireConfigTranslatorContract(
      isNonEmptyString(translator.summary),
      `${label}: translator exposes a summary`,
      translator.summary,
    );
    yield* requireConfigTranslatorContract(
      Array.isArray(translator.inputKinds),
      `${label}: translator declares inputKinds`,
      translator.inputKinds,
    );

    const mutationBaseline =
      harness.mutationProbe === undefined ? undefined : yield* harness.mutationProbe.snapshot;

    // --- detect() is authoritative for the matching input ---
    const detectInput = { appRoot: harness.matchingInput.appRoot, files: harness.matchingInput.files };
    const matches = yield* translator
      .detect(detectInput)
      .pipe(
        Effect.mapError((cause) =>
          configTranslatorContractFailure(`${label}: detect(matching) resolves`, cause),
        ),
      );
    yield* requireConfigTranslatorContract(
      matches.length > 0,
      `${label}: detect returns at least one match for the matching input`,
      matches,
    );
    yield* requireConfigTranslatorContract(
      matches.every((match: ConfigTranslateMatch) => isNonEmptyString(match.translator)),
      `${label}: each detect match names its translator`,
      matches,
    );

    // --- detect() is authoritative for a non-matching input ---
    if (harness.nonMatchingInput) {
      const nonMatches = yield* translator
        .detect({ appRoot: harness.nonMatchingInput.appRoot, files: harness.nonMatchingInput.files })
        .pipe(
          Effect.mapError((cause) =>
            configTranslatorContractFailure(`${label}: detect(non-matching) resolves`, cause),
          ),
        );
      yield* requireConfigTranslatorContract(
        nonMatches.length === 0,
        `${label}: detect returns no match for the non-matching input (globs alone never force translation)`,
        nonMatches,
      );
    }

    // --- translate() returns a fragment + diagnostics ---
    const result = yield* translator
      .translate(harness.matchingInput)
      .pipe(
        Effect.mapError((cause) =>
          configTranslatorContractFailure(`${label}: translate(matching) resolves`, cause),
        ),
      );
    yield* requireConfigTranslatorContract(
      typeof result.fragment === "object" && result.fragment !== null && !Array.isArray(result.fragment),
      `${label}: translate returns an object fragment (never an AppPlan/array)`,
      result.fragment,
    );
    yield* requireConfigTranslatorContract(
      !("plan" in result.fragment) && !("appId" in result.fragment),
      `${label}: fragment is a LandofileShape fragment, not an AppPlan`,
      result.fragment,
    );
    yield* requireConfigTranslatorContract(
      Array.isArray(result.diagnostics),
      `${label}: translate returns diagnostics`,
      result.diagnostics,
    );

    if (harness.expectedFragment) {
      yield* requireConfigTranslatorContract(
        stableJson(result.fragment) === stableJson(harness.expectedFragment),
        `${label}: translate emits the expected fragment`,
        { actual: result.fragment, expected: harness.expectedFragment },
      );
    }

    // --- translate() is deterministic ---
    const result2 = yield* translator
      .translate(harness.matchingInput)
      .pipe(
        Effect.mapError((cause) =>
          configTranslatorContractFailure(`${label}: repeat translate resolves`, cause),
        ),
      );
    yield* requireConfigTranslatorContract(
      stableJson(result.fragment) === stableJson(result2.fragment),
      `${label}: translate is deterministic for identical input`,
      { first: result.fragment, second: result2.fragment },
    );

    // --- the emitted fragment round-trips through the canonical serializer ---
    const emitEither = emitLandofileYamlEither(result.fragment as Record<string, unknown>);
    let emitted: string;
    if (Either.isLeft(emitEither)) {
      yield* requireConfigTranslatorContract(
        false,
        `${label}: emitted fragment is serializable by the canonical Landofile emitter`,
        emitEither.left,
      );
      emitted = "";
    } else {
      emitted = emitEither.right;
    }
    const reparsed = yield* parseLandofile({ file: "lando.yml", content: emitted, cwd: "/" }).pipe(
      Effect.mapError((cause) =>
        configTranslatorContractFailure(
          `${label}: emitted fragment parses through the canonical serializer`,
          cause,
        ),
      ),
    );
    yield* requireConfigTranslatorContract(
      stableJson(reparsed) === stableJson(result.fragment),
      `${label}: emitted fragment round-trips through the canonical Landofile serializer`,
      { reparsed, fragment: result.fragment, emitted },
    );

    // --- optional: options are validated before translate ---
    if (harness.optionsSchema && harness.invalidOptions !== undefined) {
      const decoded = Schema.decodeUnknownEither(harness.optionsSchema)(harness.invalidOptions);
      yield* requireConfigTranslatorContract(
        Either.isLeft(decoded),
        `${label}: invalid options fail schema decode before translate`,
        decoded,
      );

      const invalidOptionsRecord: Record<string, unknown> =
        typeof harness.invalidOptions === "object" &&
        harness.invalidOptions !== null &&
        !Array.isArray(harness.invalidOptions)
          ? (harness.invalidOptions as Record<string, unknown>)
          : { value: harness.invalidOptions };
      const invalidInput: ConfigTranslateInput = {
        ...harness.matchingInput,
        options: invalidOptionsRecord,
      };
      const invalidTranslateExit = yield* Effect.exit(translator.translate(invalidInput));
      yield* requireConfigTranslatorContract(
        Exit.isFailure(invalidTranslateExit),
        `${label}: translate rejects invalid options (must not succeed before schema validation)`,
        invalidTranslateExit,
      );
    }

    // --- optional: translate performed no external mutation ---
    if (harness.mutationProbe) {
      yield* translator
        .translate(harness.matchingInput)
        .pipe(
          Effect.mapError((cause) =>
            configTranslatorContractFailure(`${label}: mutation-probe translate resolves`, cause),
          ),
        );
      const unchanged = yield* harness.mutationProbe.assertUnchanged(mutationBaseline);
      yield* requireConfigTranslatorContract(
        unchanged,
        `${label}: translate did not mutate files / contact providers / install plugins`,
        mutationBaseline,
      );
    }
  });

export const makeConfigTranslatorContractSuite = runConfigTranslatorContractSuite;

// ---------------------------------------------------------------------------
// RouteFilter contract suite
// ---------------------------------------------------------------------------

/**
 * Raised by a route-filter `apply` when its options fail schema decode (or the
 * transform cannot run). SDK-test-local: route filters are a placeholder
 * production surface, so this tagged error lives with the contract suite rather
 * than `@lando/sdk/errors` until the route-filter feature story lands.
 */
export class RouteFilterError extends Schema.TaggedError<RouteFilterError>()("RouteFilterError", {
  message: Schema.String,
  filter: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

const routeFilterContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `RouteFilter contract failed: ${assertion}`, assertion, details });

const requireRouteFilterContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(routeFilterContractFailure(assertion, details));

/**
 * Drives any `RouteFilter` (the six built-ins `requestHeader` /
 * `responseHeader` / `redirect` / `rewritePath` / `stripPrefix` / `addPrefix`,
 * or a plugin-contributed filter) through the published route-filter contract:
 * the filter is provider-neutral (emits a declarative transform of the route
 * intent, never proxy-native middleware); `apply` is pure / deterministic /
 * idempotent; invalid options fail schema decode with a tagged error before the
 * plan is built; and ordering is stable across replays.
 *
 * The harness is generic over the route-plan shape (`Route`) so a fixture can
 * carry header/redirect metadata on a local `RoutePlan` extension without
 * widening the SDK `RoutePlan` schema.
 */
export interface RouteFilterContractHarness<Route, Options> {
  /** The built-in/plugin filter id (e.g. `rewritePath`). */
  readonly id: string;
  /** The filter's option schema. */
  readonly schema: Schema.Schema<Options, unknown>;
  /** A valid options value the schema accepts. */
  readonly validOptions: Options;
  /** An options value the schema must reject. */
  readonly invalidOptions: unknown;
  /** The declarative route intent fed to `apply`. */
  readonly input: Route;
  /** The pure, declarative transform under test. */
  readonly apply: (route: Route, options: Options) => Effect.Effect<Route, RouteFilterError>;
  /** The exact route intent `apply(input, validOptions)` must produce. */
  readonly expected: Route;
  /** Optional declared capabilities to match against observed behavior. */
  readonly capabilities?: ReadonlyArray<string>;
  /** Optional observed behavior tags; when supplied, must equal `capabilities`. */
  readonly behaviorTags?: ReadonlyArray<string>;
  /**
   * Optional replay sequence: applying the same options across this list of
   * routes must produce a stable, order-preserving output across replays.
   */
  readonly applySequence?: ReadonlyArray<Route>;
}

export const runRouteFilterContractSuite = <Route, Options>(
  harness: RouteFilterContractHarness<Route, Options>,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.id;

    yield* requireRouteFilterContract(
      isNonEmptyString(harness.id),
      `${label}: filter exposes a non-empty id`,
      harness.id,
    );

    // --- invalid options fail schema decode with a tagged error ---
    const invalidDecoded = Schema.decodeUnknownEither(harness.schema)(harness.invalidOptions);
    yield* requireRouteFilterContract(
      Either.isLeft(invalidDecoded),
      `${label}: invalid options fail schema decode before the plan is built`,
      invalidDecoded,
    );

    // --- valid options decode ---
    const validDecoded = Schema.decodeUnknownEither(harness.schema)(harness.validOptions);
    yield* requireRouteFilterContract(
      Either.isRight(validDecoded),
      `${label}: valid options decode`,
      validDecoded,
    );

    // --- apply produces the expected declarative route intent ---
    const applied = yield* harness
      .apply(harness.input, harness.validOptions)
      .pipe(
        Effect.mapError((cause) =>
          routeFilterContractFailure(`${label}: apply(input, validOptions) resolves`, cause),
        ),
      );
    yield* requireRouteFilterContract(
      stableJson(applied) === stableJson(harness.expected),
      `${label}: apply produces the expected route intent`,
      { actual: applied, expected: harness.expected },
    );

    // --- output stays declarative data (a plain object, not a function/middleware) ---
    yield* requireRouteFilterContract(
      typeof applied === "object" &&
        applied !== null &&
        (Object.getPrototypeOf(applied) === Object.prototype || Object.getPrototypeOf(applied) === null),
      `${label}: apply emits declarative route data, never proxy-native middleware`,
      applied,
    );

    // --- apply is deterministic ---
    const appliedAgain = yield* harness
      .apply(harness.input, harness.validOptions)
      .pipe(Effect.mapError((cause) => routeFilterContractFailure(`${label}: repeat apply resolves`, cause)));
    yield* requireRouteFilterContract(
      stableJson(applied) === stableJson(appliedAgain),
      `${label}: apply is deterministic for identical input/options`,
      { first: applied, second: appliedAgain },
    );

    // --- apply is idempotent (applying to its own output yields the same output) ---
    const reapplied = yield* harness
      .apply(applied, harness.validOptions)
      .pipe(
        Effect.mapError((cause) =>
          routeFilterContractFailure(`${label}: idempotent reapply resolves`, cause),
        ),
      );
    yield* requireRouteFilterContract(
      stableJson(reapplied) === stableJson(applied),
      `${label}: apply is idempotent (apply twice equals apply once)`,
      { once: applied, twice: reapplied },
    );

    // --- optional: capability declaration matches observed behavior ---
    if (harness.capabilities && harness.behaviorTags) {
      const declared = [...harness.capabilities].sort();
      const observed = [...harness.behaviorTags].sort();
      yield* requireRouteFilterContract(
        JSON.stringify(declared) === JSON.stringify(observed),
        `${label}: declared capabilities match observed behavior`,
        { declared, observed },
      );
    }

    // --- optional: ordering is stable across replays ---
    if (harness.applySequence) {
      const runSequence = () =>
        Effect.forEach(harness.applySequence ?? [], (route) =>
          harness
            .apply(route, harness.validOptions)
            .pipe(
              Effect.mapError((cause) =>
                routeFilterContractFailure(`${label}: sequence apply resolves`, cause),
              ),
            ),
        );
      const firstPass = yield* runSequence();
      const secondPass = yield* runSequence();
      yield* requireRouteFilterContract(
        stableJson(firstPass) === stableJson(secondPass),
        `${label}: filter ordering/output is stable across replays`,
        { firstPass, secondPass },
      );
    }
  });

export const makeRouteFilterContractSuite = runRouteFilterContractSuite;

// ---------------------------------------------------------------------------
// Doctor check contract suite
// ---------------------------------------------------------------------------

/** A remediation a doctor issue carries — either an automatic command or manual steps. */
export type DoctorCheckSolutionKind = "automatic" | "manual";

/** A single issue reported by a doctor check. */
export interface DoctorCheckIssue {
  /** Issue severity. */
  readonly severity: "info" | "warning" | "error";
  /** Structured context describing what was inspected. */
  readonly context: Readonly<Record<string, string>>;
  /** The remediation kind. */
  readonly solutionKind: DoctorCheckSolutionKind;
  /** Human-readable solution description. */
  readonly solution: string;
  /** Automatic solution command (present only for `automatic` solutions). */
  readonly command?: string;
}

/** Result of running a doctor check. SDK-test-local (no `doctorChecks:` SDK surface yet). */
export interface DoctorCheckResult {
  /** The check id. */
  readonly id: string;
  /** Issues found (empty = healthy). */
  readonly issues: ReadonlyArray<DoctorCheckIssue>;
}

/**
 * Raised by a doctor check `run` when the check cannot execute. SDK-test-local:
 * doctor checks are not a published plugin contribution surface yet, so this tagged error lives
 * with the contract suite rather than `@lando/sdk/errors`.
 */
export class DoctorCheckError extends Schema.TaggedError<DoctorCheckError>()("DoctorCheckError", {
  message: Schema.String,
  check: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

const doctorCheckContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Doctor check contract failed: ${assertion}`, assertion, details });

const requireDoctorCheckContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(doctorCheckContractFailure(assertion, details));

/**
 * Drives any doctor check (the built-in core checks or a `doctorChecks:`
 * contribution) through the published doctor-check contract: `run()` returns
 * issues carrying severity / context and an automatic|manual solution; default
 * runs are read-only and only `--fix` executes automatic solutions; shell-shaped
 * probes route through `ShellRunner` (so they appear in the redacted doctor
 * transcript); and secrets are redacted. `check` is required; the
 * remaining fields are optional probes asserted only when supplied.
 */
export interface DoctorCheckContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The check under test. */
  readonly check: {
    readonly id: string;
    readonly run: (input: { readonly fix: boolean }) => Effect.Effect<DoctorCheckResult, DoctorCheckError>;
  };
  /** Optional: the issue shape `run({ fix: false })` must report. */
  readonly expectedIssue?: {
    readonly severity: "info" | "warning" | "error";
    readonly contextKey?: string;
    readonly solutionKind: DoctorCheckSolutionKind;
  };
  /**
   * Optional: snapshot/assert pair proving a default `run({ fix: false })`
   * performed no mutation.
   */
  readonly readOnlyProbe?: {
    readonly snapshot: Effect.Effect<unknown>;
    readonly assertUnchanged: (before: unknown) => Effect.Effect<boolean>;
  };
  /**
   * Optional: asserts `run({ fix: true })` executed an automatic solution
   * (returns whether the fix ran).
   */
  readonly fixProbe?: Effect.Effect<boolean>;
  /**
   * Optional: returns the redacted transcript lines produced by the check's
   * shell-shaped probes (proving they routed through `ShellRunner`).
   */
  readonly shellRunnerProbe?: Effect.Effect<ReadonlyArray<string>>;
  /** Optional: a secret value that must be absent from the redacted transcript. */
  readonly secretValue?: string;
  /** Optional: the rendered transcript string the secret must not appear in. */
  readonly redactedTranscriptProbe?: Effect.Effect<string>;
}

export const runDoctorCheckContractSuite = (
  harness: DoctorCheckContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.check.id;

    yield* requireDoctorCheckContract(
      isNonEmptyString(harness.check.id),
      `${label}: check exposes a non-empty id`,
      harness.check.id,
    );

    const readOnlyBaseline =
      harness.readOnlyProbe === undefined ? undefined : yield* harness.readOnlyProbe.snapshot;

    // --- default run returns issues carrying severity/context + a solution ---
    const result = yield* harness.check
      .run({ fix: false })
      .pipe(
        Effect.mapError((cause) =>
          doctorCheckContractFailure(`${label}: run({ fix: false }) resolves`, cause),
        ),
      );
    yield* requireDoctorCheckContract(
      Array.isArray(result.issues),
      `${label}: run returns a DoctorCheckResult with an issues array`,
      result,
    );
    for (const issue of result.issues) {
      yield* requireDoctorCheckContract(
        issue.severity === "info" || issue.severity === "warning" || issue.severity === "error",
        `${label}: each issue carries a valid severity`,
        issue,
      );
      yield* requireDoctorCheckContract(
        typeof issue.context === "object" && issue.context !== null,
        `${label}: each issue carries structured context`,
        issue,
      );
      yield* requireDoctorCheckContract(
        issue.solutionKind === "automatic" || issue.solutionKind === "manual",
        `${label}: each issue carries an automatic or manual solution`,
        issue,
      );
      if (issue.solutionKind === "automatic") {
        yield* requireDoctorCheckContract(
          isNonEmptyString(issue.command),
          `${label}: an automatic solution carries a command`,
          issue,
        );
      }
    }

    if (harness.expectedIssue) {
      const expected = harness.expectedIssue;
      const match = result.issues.find(
        (issue) =>
          issue.severity === expected.severity &&
          issue.solutionKind === expected.solutionKind &&
          (expected.contextKey === undefined || expected.contextKey in issue.context),
      );
      yield* requireDoctorCheckContract(
        match !== undefined,
        `${label}: run reports an issue matching the expected shape`,
        { expected, issues: result.issues },
      );
    }

    // --- optional: default run is read-only ---
    if (harness.readOnlyProbe) {
      yield* harness.check
        .run({ fix: false })
        .pipe(
          Effect.mapError((cause) =>
            doctorCheckContractFailure(`${label}: read-only probe run resolves`, cause),
          ),
        );
      const unchanged = yield* harness.readOnlyProbe.assertUnchanged(readOnlyBaseline);
      yield* requireDoctorCheckContract(
        unchanged,
        `${label}: default run({ fix: false }) performs no mutation`,
        readOnlyBaseline,
      );
    }

    // --- optional: --fix executes automatic solutions ---
    if (harness.fixProbe) {
      yield* harness.check
        .run({ fix: true })
        .pipe(
          Effect.mapError((cause) =>
            doctorCheckContractFailure(`${label}: run({ fix: true }) resolves`, cause),
          ),
        );
      const fixed = yield* harness.fixProbe;
      yield* requireDoctorCheckContract(
        fixed,
        `${label}: run({ fix: true }) executes the automatic solution`,
        fixed,
      );
    }

    // --- optional: shell-shaped probes route through ShellRunner (transcript evidence) ---
    if (harness.shellRunnerProbe) {
      const transcript = yield* harness.shellRunnerProbe;
      yield* requireDoctorCheckContract(
        transcript.length > 0,
        `${label}: shell-shaped probes appear in the doctor transcript via ShellRunner`,
        transcript,
      );
    }

    // --- optional: secrets are redacted from the transcript ---
    if (harness.redactedTranscriptProbe && isNonEmptyString(harness.secretValue)) {
      const transcript = yield* harness.redactedTranscriptProbe;
      yield* requireDoctorCheckContract(
        !transcript.includes(harness.secretValue),
        `${label}: the redacted transcript never contains a raw secret value`,
        { transcript },
      );
    }
  });

export const makeDoctorCheckContractSuite = runDoctorCheckContractSuite;

// ---------------------------------------------------------------------------
// ToolingEngine contract suite
// ---------------------------------------------------------------------------

const toolingEngineContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ToolingEngine contract failed: ${assertion}`, assertion, details });

const requireToolingEngineContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(toolingEngineContractFailure(assertion, details));

/** Minimal structural view of a `ToolingEngine` the contract suite drives. */
export interface ToolingEngineUnderTest {
  /** The engine id (e.g. `providerExec`, `host`). */
  readonly id: string;
  /** Translate an invocation into a single aggregated result. */
  readonly run: (
    invocation: ToolingInvocation,
    plan: AppPlan,
    provider: RuntimeProviderShape,
  ) => Effect.Effect<ToolingEngineResult, unknown>;
}

/**
 * Drives any `ToolingEngine` through the published execution contract: a
 * non-empty id, an `Effect`-typed `run`, ordered sequential command execution,
 * a first-non-zero-exit short-circuit, a deterministic aggregated result, and a
 * tagged `ToolingExecError` (carrying the failing task id) on a non-zero exit.
 * `engine`, `okScenario`, and `failScenario` are required; the remaining fields
 * are optional probes asserted only when the harness supplies the hook. The
 * harness owns the `AppPlan`/`RuntimeProviderShape` doubles so the suite never
 * contacts a real provider.
 */
export interface ToolingEngineContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The engine under test. */
  readonly engine: ToolingEngineUnderTest;
  /**
   * A scenario whose every command exits zero. The suite asserts ordered
   * execution, the captured command sequence, and the aggregated result.
   */
  readonly okScenario: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    /**
     * Build a fresh recording provider for one run. `record` returns, in
     * execution order, the argv of every command the engine handed to the
     * provider (or host) so the suite can assert sequencing.
     */
    readonly makeProvider: () => {
      readonly provider: RuntimeProviderShape;
      readonly record: () => ReadonlyArray<ReadonlyArray<string>>;
    };
    /** The exact aggregated result the engine must produce. */
    readonly expected: ToolingEngineResult;
    /** The exact ordered argv sequence the engine must have executed. */
    readonly expectedCommands: ReadonlyArray<ReadonlyArray<string>>;
  };
  /**
   * A scenario whose Nth command exits non-zero. The suite asserts the engine
   * stops at the first failure and that the result carries that exit code.
   */
  readonly failScenario: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly makeProvider: () => {
      readonly provider: RuntimeProviderShape;
      readonly record: () => ReadonlyArray<ReadonlyArray<string>>;
    };
    /** The non-zero exit code the aggregated result must report. */
    readonly expectedExitCode: number;
    /** The number of commands that must have executed before the short-circuit. */
    readonly expectedCommandCount: number;
  };
  /**
   * A scenario that fails `run` with a tagged `ToolingExecError`. The suite
   * asserts the error carries the invocation's `tool` (the failing task id).
   */
  readonly execErrorScenario: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly provider: RuntimeProviderShape;
  };
  /**
   * Optional: declared capabilities and observed behavior tags. When supplied,
   * the suite asserts they match (sorted equality).
   */
  readonly capabilities?: ReadonlyArray<string>;
  /** Optional: observed behavior tags compared against {@link capabilities}. */
  readonly behaviorTags?: ReadonlyArray<string>;
  /**
   * Optional: an interruption probe. `run` must be a long-running effect the
   * suite can `Effect.interrupt`; `assertFinalized` reports whether the in-flight
   * work was finalized (no orphaned child) after the interrupt.
   */
  readonly interruptionProbe?: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly provider: RuntimeProviderShape;
    readonly assertFinalized: Effect.Effect<boolean>;
  };
  /**
   * Optional: a redaction probe proving a secret value supplied through the
   * invocation never survives in the aggregated result output.
   */
  readonly redactionProbe?: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly makeProvider: () => { readonly provider: RuntimeProviderShape };
    readonly secretValue: string;
    /** Extract the rendered output the secret must be absent from. */
    readonly render: (result: ToolingEngineResult) => string;
  };
}

export const runToolingEngineContractSuite = (
  harness: ToolingEngineContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.engine.id;
    const engine = harness.engine;

    yield* requireToolingEngineContract(
      isNonEmptyString(engine.id),
      `${label}: engine exposes a non-empty id`,
      engine.id,
    );
    yield* requireToolingEngineContract(
      Effect.isEffect(
        engine.run(
          harness.okScenario.invocation,
          harness.okScenario.plan,
          harness.okScenario.makeProvider().provider,
        ),
      ),
      `${label}: run is Effect-typed`,
    );

    // --- ordered sequential execution + aggregated result ---
    const okRun = harness.okScenario.makeProvider();
    const okResult = yield* engine
      .run(harness.okScenario.invocation, harness.okScenario.plan, okRun.provider)
      .pipe(
        Effect.mapError((cause) => toolingEngineContractFailure(`${label}: ok scenario run resolves`, cause)),
      );
    yield* requireToolingEngineContract(
      stableJson(okResult) === stableJson(harness.okScenario.expected),
      `${label}: run produces the expected aggregated result`,
      { actual: okResult, expected: harness.okScenario.expected },
    );
    yield* requireToolingEngineContract(
      stableJson(okRun.record()) === stableJson(harness.okScenario.expectedCommands),
      `${label}: run executes commands in declared order`,
      { actual: okRun.record(), expected: harness.okScenario.expectedCommands },
    );

    // --- determinism across repeated runs of the same scenario ---
    const okRunAgain = harness.okScenario.makeProvider();
    const okResultAgain = yield* engine
      .run(harness.okScenario.invocation, harness.okScenario.plan, okRunAgain.provider)
      .pipe(
        Effect.mapError((cause) =>
          toolingEngineContractFailure(`${label}: repeat ok scenario run resolves`, cause),
        ),
      );
    yield* requireToolingEngineContract(
      stableJson(okResult) === stableJson(okResultAgain),
      `${label}: run is deterministic for the same scenario`,
      { first: okResult, second: okResultAgain },
    );

    // --- first non-zero exit short-circuits the remaining commands ---
    const failRun = harness.failScenario.makeProvider();
    const failResult = yield* engine
      .run(harness.failScenario.invocation, harness.failScenario.plan, failRun.provider)
      .pipe(
        Effect.mapError((cause) =>
          toolingEngineContractFailure(`${label}: fail scenario run resolves with a non-zero result`, cause),
        ),
      );
    yield* requireToolingEngineContract(
      failResult.exitCode === harness.failScenario.expectedExitCode,
      `${label}: run reports the failing command's exit code`,
      { actual: failResult.exitCode, expected: harness.failScenario.expectedExitCode },
    );
    yield* requireToolingEngineContract(
      failRun.record().length === harness.failScenario.expectedCommandCount,
      `${label}: run stops at the first non-zero exit`,
      { actual: failRun.record().length, expected: harness.failScenario.expectedCommandCount },
    );

    // --- a failed launch maps to a tagged ToolingExecError carrying the tool id ---
    const execErrorExit = yield* Effect.exit(
      engine.run(
        harness.execErrorScenario.invocation,
        harness.execErrorScenario.plan,
        harness.execErrorScenario.provider,
      ),
    );
    yield* requireToolingEngineContract(
      Exit.isFailure(execErrorExit),
      `${label}: exec-error scenario fails`,
      execErrorExit,
    );
    if (Exit.isFailure(execErrorExit)) {
      const failure = Cause.failureOption(execErrorExit.cause);
      yield* requireToolingEngineContract(
        Option.isSome(failure) && failure.value instanceof ToolingExecError,
        `${label}: failure is a tagged ToolingExecError`,
        execErrorExit.cause,
      );
      if (Option.isSome(failure) && failure.value instanceof ToolingExecError) {
        yield* requireToolingEngineContract(
          failure.value.tool === harness.execErrorScenario.invocation.tool,
          `${label}: ToolingExecError carries the failing task id`,
          { actual: failure.value.tool, expected: harness.execErrorScenario.invocation.tool },
        );
      }
    }

    // --- optional: capability declaration matches observed behavior ---
    if (harness.capabilities && harness.behaviorTags) {
      const declared = [...harness.capabilities].sort();
      const observed = [...harness.behaviorTags].sort();
      yield* requireToolingEngineContract(
        JSON.stringify(declared) === JSON.stringify(observed),
        `${label}: declared capabilities match observed behavior`,
        { declared, observed },
      );
    }

    // --- optional: interruption cancels in-flight work and finalizes children ---
    if (harness.interruptionProbe) {
      const probe = harness.interruptionProbe;
      const fiber = yield* Effect.fork(
        engine.run(probe.invocation, probe.plan, probe.provider).pipe(Effect.either),
      );
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(fiber);
      const finalized = yield* probe.assertFinalized;
      yield* requireToolingEngineContract(
        finalized === true,
        `${label}: interruption finalizes in-flight work (no orphaned child)`,
        { finalized },
      );
    }

    // --- optional: a secret-resolved value never reaches the result output ---
    if (harness.redactionProbe) {
      const probe = harness.redactionProbe;
      const result = yield* engine
        .run(probe.invocation, probe.plan, probe.makeProvider().provider)
        .pipe(
          Effect.mapError((cause) =>
            toolingEngineContractFailure(`${label}: redaction scenario run resolves`, cause),
          ),
        );
      const rendered = probe.render(result);
      yield* requireToolingEngineContract(
        !rendered.includes(probe.secretValue),
        `${label}: secret-resolved values never reach the result output`,
        { rendered },
      );
    }
  });

export const makeToolingEngineContractSuite = runToolingEngineContractSuite;

// ---------------------------------------------------------------------------
// PluginSource contract suite
// ---------------------------------------------------------------------------

/** A tagged error a plugin-source resolution may fail with. */
export interface PluginSourceTaggedError {
  readonly _tag: string;
  readonly message: string;
  readonly remediation?: string;
}

const pluginSourceContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `PluginSource contract failed: ${assertion}`, assertion, details });

const requirePluginSourceContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(pluginSourceContractFailure(assertion, details));

/**
 * Drives any `PluginSource` through the published resolution contract: a
 * non-empty id, a `resolve(spec)` that yields a package root contained under a
 * Lando-managed store after realpath resolution, an escaping spec that fails
 * with a tagged error carrying remediation, and deterministic resolution.
 * Because the built-in source adapters land with `lando plugin:add`, the
 * containment behavior is supplied through the harness `resolve` probe (modeling
 * the real registry containment guarantee) rather than read off the bare SDK
 * tag. `source`, `managedStoreRoot`, `containedSpec`, and `escapingSpec` are
 * required; `network`/`auth`/`offline` are optional probes.
 */
export interface PluginSourceContractHarness<Spec> {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The source under test (the bare SDK tag value plus a resolve probe). */
  readonly source: { readonly id: string };
  /**
   * Resolve a spec to an absolute, realpath-resolved package root, or fail with
   * a tagged error. Models the containment guarantee the built-in registry
   * enforces today (and future source adapters will satisfy directly).
   */
  readonly resolve: (spec: Spec) => Effect.Effect<string, PluginSourceTaggedError>;
  /** The absolute, realpath-resolved Lando-managed store the root must stay under. */
  readonly managedStoreRoot: string;
  /** A spec that resolves to a package root contained under the managed store. */
  readonly containedSpec: Spec;
  /** A spec that escapes the managed store (via `..`/symlink) and must fail. */
  readonly escapingSpec: Spec;
  /**
   * Optional: a probe proving resolution honored `network.proxy`/`network.ca`.
   * Returns the network trust values observed during a resolve.
   */
  readonly networkTrustProbe?: {
    readonly resolve: Effect.Effect<unknown, PluginSourceTaggedError>;
    readonly observed: Effect.Effect<{ readonly proxy?: string; readonly ca?: string }>;
    readonly expected: { readonly proxy?: string; readonly ca?: string };
  };
  /**
   * Optional: a registry-auth token plus the rendered log/event output it must
   * be absent from after a resolve.
   */
  readonly authRedactionProbe?: {
    readonly token: string;
    readonly renderedOutput: Effect.Effect<string>;
  };
  /**
   * Optional: an already-locked spec that must resolve offline without a
   * re-fetch. `fetchCount` reports how many times the network was contacted.
   */
  readonly offlineLockedProbe?: {
    readonly spec: Spec;
    readonly resolve: (spec: Spec) => Effect.Effect<string, PluginSourceTaggedError>;
    readonly fetchCount: Effect.Effect<number>;
  };
}

export const runPluginSourceContractSuite = <Spec>(
  harness: PluginSourceContractHarness<Spec>,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.source.id;

    yield* requirePluginSourceContract(
      isNonEmptyString(harness.source.id),
      `${label}: source exposes a non-empty id`,
      harness.source.id,
    );

    // --- a contained spec resolves to a realpath under the managed store ---
    const contained = yield* harness
      .resolve(harness.containedSpec)
      .pipe(
        Effect.mapError((cause) => pluginSourceContractFailure(`${label}: contained spec resolves`, cause)),
      );
    const root = harness.managedStoreRoot;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    yield* requirePluginSourceContract(
      contained === root || contained.startsWith(prefix),
      `${label}: resolved root stays under the managed store after realpath`,
      { resolved: contained, managedStoreRoot: root },
    );

    // --- resolution is deterministic ---
    const containedAgain = yield* harness
      .resolve(harness.containedSpec)
      .pipe(
        Effect.mapError((cause) =>
          pluginSourceContractFailure(`${label}: repeat contained spec resolves`, cause),
        ),
      );
    yield* requirePluginSourceContract(
      contained === containedAgain,
      `${label}: resolution is deterministic for the same spec`,
      { first: contained, second: containedAgain },
    );

    // --- an escaping spec fails with a tagged error carrying remediation ---
    const escapeExit = yield* Effect.exit(harness.resolve(harness.escapingSpec));
    yield* requirePluginSourceContract(
      Exit.isFailure(escapeExit),
      `${label}: escaping spec fails`,
      escapeExit,
    );
    if (Exit.isFailure(escapeExit)) {
      const failure = Cause.failureOption(escapeExit.cause);
      yield* requirePluginSourceContract(
        Option.isSome(failure) && typeof (failure.value as { _tag?: unknown })._tag === "string",
        `${label}: escape failure is a tagged error (carries _tag)`,
        escapeExit.cause,
      );
      if (Option.isSome(failure)) {
        const remediation = (failure.value as { remediation?: unknown }).remediation;
        yield* requirePluginSourceContract(
          typeof remediation === "string" && remediation.length > 0,
          `${label}: escape failure carries remediation`,
          failure.value,
        );
      }
    }

    // --- optional: resolution honored network.proxy/network.ca ---
    if (harness.networkTrustProbe) {
      const probe = harness.networkTrustProbe;
      yield* probe.resolve.pipe(
        Effect.mapError((cause) =>
          pluginSourceContractFailure(`${label}: network-trust resolve resolves`, cause),
        ),
      );
      const observed = yield* probe.observed;
      yield* requirePluginSourceContract(
        observed.proxy === probe.expected.proxy && observed.ca === probe.expected.ca,
        `${label}: resolution honored network.proxy/network.ca`,
        { observed, expected: probe.expected },
      );
    }

    // --- optional: registry auth tokens are redacted from logs/events ---
    if (harness.authRedactionProbe) {
      const probe = harness.authRedactionProbe;
      const rendered = yield* probe.renderedOutput;
      yield* requirePluginSourceContract(
        !rendered.includes(probe.token),
        `${label}: registry auth token is redacted from logs/events`,
        { rendered },
      );
    }

    // --- optional: already-locked sources resolve offline without re-fetch ---
    if (harness.offlineLockedProbe) {
      const probe = harness.offlineLockedProbe;
      yield* probe
        .resolve(probe.spec)
        .pipe(
          Effect.mapError((cause) =>
            pluginSourceContractFailure(`${label}: offline-locked resolve resolves`, cause),
          ),
        );
      const fetches = yield* probe.fetchCount;
      yield* requirePluginSourceContract(
        fetches === 0,
        `${label}: already-locked source resolves offline without a re-fetch`,
        { fetches },
      );
    }
  });

export const makePluginSourceContractSuite = runPluginSourceContractSuite;
