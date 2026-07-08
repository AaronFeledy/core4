import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Either, Schema } from "effect";

import {
  JSON_SCHEMA_NAMES,
  type JsonSchemaName,
  getJsonSchema,
  publicSchemaRegistry,
} from "../../src/schema/index.ts";

const ISO_TIMESTAMP = "2026-06-14T00:00:00.000Z";
const PUBLIC_SCHEMA_CONTRACT_TEST_FILE = "sdk/test/schema/public-schema-contracts.test.ts";

export type PublicSchemaContractFixture = {
  readonly testFile: `sdk/test/schema/${string}.test.ts`;
};

export const PUBLIC_SCHEMA_CONTRACT_FIXTURES = {
  DeprecationNotice: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DeprecationUse: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  LandofileExpressionParseError: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  LandofileExpressionForbiddenError: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  LandofileExpressionEvalError: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  GuideFrontmatter: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  GuideProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ScenarioProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  StepProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RunProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VerifyProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CleanupProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VariableProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HiddenProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  InspectProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TabsProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TabProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  InlineProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  SkipProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  UseFixtureProps: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  MatcherSchema: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  Transcript: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PublicTranscript: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ExpressionNode: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ExpressionTemplate: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  BootstrapLevel: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HostArchitecture: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  AppRef: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ArtifactRef: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ArtifactBuildSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ArtifactManifestEntry: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  BuildScript: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  BuildPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  BuildStep: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  AppPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ServicePlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  AppMountPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  MountPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DataStorePlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DataStoreMountPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  StorageScope: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  EndpointPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RouteRef: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RoutePlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HealthcheckPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CertificatePlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HostAliasPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DependencyPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  NetworkPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PerAppBridgePlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  SharedNetworkMembershipPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  NetworkingPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  IsolateMode: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ProviderCapabilities: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  LandofileShape: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ServiceConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  LogSource: "sdk/test/schema/log-source.test.ts",
  LogSourceId: "sdk/test/schema/log-source.test.ts",
  LogSourceInput: "sdk/test/schema/log-source.test.ts",
  LogSourceStream: "sdk/test/schema/log-source.test.ts",
  LogSourceStrategy: "sdk/test/schema/log-source.test.ts",
  EndpointInput: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RouteInput: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HealthcheckInput: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ToolingVar: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ToolingFlagShape: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ToolingArgShape: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ToolingTaskShape: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  IncludeEntry: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  McpConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  AgentEnvConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TelemetryConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  NetworkProxyConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  NetworkCaConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  NetworkConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  GlobalConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ConfigLintViolation: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ConfigLintResult: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DownloadRequest: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DownloadResult: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DownloaderCapabilities: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ArchiveFormat: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DataEndpoint: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VolumeRef: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VolumeInfo: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VolumeFilter: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VolumeSnapshotSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VolumeSnapshotRef: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  VolumeRestoreSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ServiceCopyInSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ServiceCopyOutSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DataTransferSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DataTransferResult: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DataTransferProgress: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  SnapshotHandle: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  SnapshotInfo: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  SnapshotFilter: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PrunePolicy: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RemoteCapabilities: "sdk/test/schema/remote-sync.test.ts",
  RemoteConfig: "sdk/test/schema/remote-sync.test.ts",
  RemoteEnvironment: "sdk/test/schema/remote-sync.test.ts",
  RemoteEnvId: "sdk/test/schema/remote-sync.test.ts",
  RemoteLocator: "sdk/test/schema/remote-sync.test.ts",
  RemoteFetchOptions: "sdk/test/schema/remote-sync.test.ts",
  RemoteSendOptions: "sdk/test/schema/remote-sync.test.ts",
  RemoteTestResult: "sdk/test/schema/remote-sync.test.ts",
  DatasetBinding: "sdk/test/schema/remote-sync.test.ts",
  DatasetKind: "sdk/test/schema/remote-sync.test.ts",
  DatasetCapabilities: "sdk/test/schema/remote-sync.test.ts",
  DatasetArtifactFormat: "sdk/test/schema/remote-sync.test.ts",
  DatasetContext: "sdk/test/schema/remote-sync.test.ts",
  DatasetCaptureOptions: "sdk/test/schema/remote-sync.test.ts",
  DatasetApplyOptions: "sdk/test/schema/remote-sync.test.ts",
  DatasetApplyResult: "sdk/test/schema/remote-sync.test.ts",
  SyncResult: "sdk/test/schema/remote-sync.test.ts",
  TunnelCapabilities: "sdk/test/schema/tunnel.test.ts",
  TunnelTarget: "sdk/test/schema/tunnel.test.ts",
  TunnelStartRequest: "sdk/test/schema/tunnel.test.ts",
  TunnelStopRequest: "sdk/test/schema/tunnel.test.ts",
  TunnelStatusRequest: "sdk/test/schema/tunnel.test.ts",
  TunnelSession: "sdk/test/schema/tunnel.test.ts",
  TunnelStatus: "sdk/test/schema/tunnel.test.ts",
  TunnelSessionFilter: "sdk/test/schema/tunnel.test.ts",
  ManagedFile: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ManagedFileInfo: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ManagedFilePlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ManagedFileResult: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  McpToolDescriptor: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  McpCatalog: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  McpCatalogOptions: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  McpServeOptions: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  AppId: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ServiceName: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ProviderId: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PluginName: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PortablePath: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CommandSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PlanMetadata: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ProviderExtensionConfig: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HostPlatform: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ServiceInfo: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  EmbeddingPluginPolicy: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ContributionRef: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PluginSetupFlagContribution: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PluginSetupContribution: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PluginContribution: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PluginManifest: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PluginTrustState: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  GlobalServiceContribution: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  FileSyncEngineCapabilities: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  FileSyncSessionSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  FileSyncSessionInfo: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  FileSyncEventChunk: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  FileSyncPlan: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RecipeChoicesFrom: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RecipeManifest: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RecipeRegistryResolution: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  RecipeRegistryResponse: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TemplateRenderContext: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  UpdateChannel: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestPlatform: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestHttpsUrl: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestSemver: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestSha256: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestBinary: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestBinaries: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestChecksums: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestSchema: "sdk/test/schema/update-manifest.test.ts",
  LandoEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreBootstrapEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostBootstrapEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ReadyEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  BeforeExitEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreInitEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostInitEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreRebuildEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostRebuildEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreDestroyEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostDestroyEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreGlobalStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostGlobalStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreGlobalStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostGlobalStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreAppStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostAppStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreAppStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostAppStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreServiceStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostServiceStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreServiceStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostServiceStopEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreBuildEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostBuildEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreManagedFileWriteEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostManagedFileWriteEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ManagedFileConflictDetectedEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  ManagedFileSkippedEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreDownloadEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DownloadProgressEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostDownloadEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PrePullEvent: "sdk/test/schema/remote-sync.test.ts",
  PostPullEvent: "sdk/test/schema/remote-sync.test.ts",
  PrePushEvent: "sdk/test/schema/remote-sync.test.ts",
  PostPushEvent: "sdk/test/schema/remote-sync.test.ts",
  PreDatasetFetchEvent: "sdk/test/schema/remote-sync.test.ts",
  PostDatasetFetchEvent: "sdk/test/schema/remote-sync.test.ts",
  PreDatasetApplyEvent: "sdk/test/schema/remote-sync.test.ts",
  PostDatasetApplyEvent: "sdk/test/schema/remote-sync.test.ts",
  PreDatasetCaptureEvent: "sdk/test/schema/remote-sync.test.ts",
  PostDatasetCaptureEvent: "sdk/test/schema/remote-sync.test.ts",
  PreDatasetSendEvent: "sdk/test/schema/remote-sync.test.ts",
  PostDatasetSendEvent: "sdk/test/schema/remote-sync.test.ts",
  PreTunnelStartEvent: "sdk/test/schema/tunnel.test.ts",
  PostTunnelStartEvent: "sdk/test/schema/tunnel.test.ts",
  TunnelReadyEvent: "sdk/test/schema/tunnel.test.ts",
  PreTunnelStopEvent: "sdk/test/schema/tunnel.test.ts",
  PostTunnelStopEvent: "sdk/test/schema/tunnel.test.ts",
  TunnelStatusEvent: "sdk/test/schema/tunnel.test.ts",
  PreProviderApplyEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostProviderApplyEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreProviderExecEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostProviderExecEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CliCommandInitEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CliCommandRunEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CliCommandErrorEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  DeprecationUsedEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskTreeStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskStartEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskDetailEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskDetailExpandEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskDetailCollapseEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskCompleteEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskFailEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  TaskTreeCompleteEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  MessageInfoEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  MessageWarnEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  MessageErrorEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PaintBannerEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PromptSpec: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  InteractionServiceContribution: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CommandResultFormat: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CommandWarning: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  CommandResultEnvelope: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  StreamFrame: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HttpClientCapabilities: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HttpRequest: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HttpResponse: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HttpStreamResponse: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  HttpUploadRequest: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PreHttpCallEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
  PostHttpCallEvent: PUBLIC_SCHEMA_CONTRACT_TEST_FILE,
} as const satisfies Record<JsonSchemaName, PublicSchemaContractFixture["testFile"]>;

type JsonObject = Record<string, unknown>;

type JsonSchemaNode = JsonObject & {
  readonly $ref?: string;
  readonly const?: unknown;
  readonly default?: unknown;
  readonly enum?: ReadonlyArray<unknown>;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly oneOf?: ReadonlyArray<JsonSchemaNode>;
  readonly allOf?: ReadonlyArray<JsonSchemaNode>;
  readonly type?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: JsonSchemaNode;
  readonly additionalProperties?: boolean | JsonSchemaNode;
};

const decodeRefToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

const resolveRef = (root: JsonSchemaNode, node: JsonSchemaNode): JsonSchemaNode => {
  let current = node;
  const seen = new Set<string>();

  while (current.$ref !== undefined) {
    if (seen.has(current.$ref)) throw new Error(`Circular JSON Schema ref: ${current.$ref}`);
    seen.add(current.$ref);
    const path = current.$ref.replace(/^#\//, "").split("/").map(decodeRefToken);
    const next = path.reduce<unknown>((value, part) => {
      if (value === null || typeof value !== "object") return undefined;
      return (value as JsonObject)[part];
    }, root);
    if (next === undefined || next === null || typeof next !== "object") {
      throw new Error(`Unresolvable JSON Schema ref: ${current.$ref}`);
    }
    current = next as JsonSchemaNode;
  }

  return current;
};

const nonEmptyStringForKey = (key: string, node: JsonSchemaNode): string => {
  if (
    node.format === "date-time" ||
    /^(timestamp|resolvedAt|startedAt|finishedAt|lastUpdatedAt|createdAt)$/i.test(key)
  ) {
    return ISO_TIMESTAMP;
  }
  if (node.format === "uri" || node.format === "url" || /url$/i.test(key))
    return "https://example.test/value";
  if (/^(since|removeIn|version)$/i.test(key)) return "4.2.0";
  if (/path|root|source|target|file|cwd/i.test(key)) return "/tmp/lando-app";
  if (/port/i.test(key)) return "3000";
  if (/ip/i.test(key)) return "127.0.0.1";
  if (/reason|justification|description|note|message|body|summary|label|title/i.test(key)) {
    return "documented value";
  }
  return "alpha";
};

const mergeObjects = (values: ReadonlyArray<unknown>): JsonObject =>
  Object.assign(
    {},
    ...values.filter(
      (value): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value),
    ),
  );

const materializeJsonSchemaFixture = (root: JsonSchemaNode, node: JsonSchemaNode, key: string): unknown => {
  const resolved = resolveRef(root, node);

  if (resolved.const !== undefined) return resolved.const;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum)) return resolved.enum[0];
  if (Array.isArray(resolved.anyOf)) return materializeJsonSchemaFixture(root, resolved.anyOf[0] ?? {}, key);
  if (Array.isArray(resolved.oneOf)) return materializeJsonSchemaFixture(root, resolved.oneOf[0] ?? {}, key);
  if (Array.isArray(resolved.allOf)) {
    return mergeObjects(resolved.allOf.map((child) => materializeJsonSchemaFixture(root, child, key)));
  }

  if (resolved.type === "string" || resolved.pattern !== undefined || resolved.format !== undefined) {
    return nonEmptyStringForKey(key, resolved);
  }
  if (resolved.type === "number" || resolved.type === "integer") return 1;
  if (resolved.type === "boolean") return false;
  if (resolved.type === "array") return [materializeJsonSchemaFixture(root, resolved.items ?? {}, key)];
  if (
    resolved.type === "object" ||
    resolved.properties !== undefined ||
    resolved.additionalProperties !== undefined
  ) {
    const object: JsonObject = {};
    for (const property of resolved.required ?? []) {
      object[property] = materializeJsonSchemaFixture(
        root,
        resolved.properties?.[property] ??
          (typeof resolved.additionalProperties === "object" ? resolved.additionalProperties : {}),
        property,
      );
    }
    return object;
  }

  return null;
};

const fixtureOverrides: Partial<Record<JsonSchemaName, unknown>> = {
  UpdateManifestHttpsUrl: "https://example.test/value",
  UpdateManifestSemver: "4.2.0",
  UpdateManifestSha256: "a".repeat(64),
  UpdateManifestBinary: { url: "https://example.test/lando-linux-x64", sha256: "a".repeat(64), size: 1 },
  UpdateManifestBinaries: {
    "darwin-x64": { url: "https://example.test/lando-darwin-x64", sha256: "a".repeat(64), size: 1 },
    "darwin-arm64": { url: "https://example.test/lando-darwin-arm64", sha256: "a".repeat(64), size: 1 },
    "linux-x64": { url: "https://example.test/lando-linux-x64", sha256: "a".repeat(64), size: 1 },
    "linux-arm64": { url: "https://example.test/lando-linux-arm64", sha256: "a".repeat(64), size: 1 },
    "windows-x64": { url: "https://example.test/lando-windows-x64.exe", sha256: "a".repeat(64), size: 1 },
  },
  UpdateManifestChecksums: {
    url: "https://example.test/SHA256SUMS",
    signature: "https://example.test/SHA256SUMS.sig",
  },
  UpdateManifestSchema: {
    channel: "stable",
    latest: "4.2.0",
    released: ISO_TIMESTAMP,
    minimum: "4.0.0",
    binaries: {
      "darwin-x64": { url: "https://example.test/lando-darwin-x64", sha256: "a".repeat(64), size: 1 },
      "darwin-arm64": { url: "https://example.test/lando-darwin-arm64", sha256: "a".repeat(64), size: 1 },
      "linux-x64": { url: "https://example.test/lando-linux-x64", sha256: "a".repeat(64), size: 1 },
      "linux-arm64": { url: "https://example.test/lando-linux-arm64", sha256: "a".repeat(64), size: 1 },
      "windows-x64": { url: "https://example.test/lando-windows-x64.exe", sha256: "a".repeat(64), size: 1 },
    },
    checksums: {
      url: "https://example.test/SHA256SUMS",
      signature: "https://example.test/SHA256SUMS.sig",
    },
    notes: "https://example.test/releases/v4.2.0",
  },
  VerifyProps: { command: "documented value" },
  InspectProps: { file: "/tmp/lando-app/output.json" },
  HiddenProps: { reason: "documented value" },
  InlineProps: { code: "alpha", justification: "documented value" },
  SkipProps: { reason: "documented value" },
  Transcript: {
    guideId: "alpha",
    scenarioId: "alpha",
    render: false,
    startedAt: ISO_TIMESTAMP,
    finishedAt: ISO_TIMESTAMP,
    durationMs: 1,
    exitStatus: "pass",
    frames: [
      {
        kind: "run",
        command: ["alpha"],
        stdout: "alpha",
        stderr: "alpha",
        exit: 0,
        durationMs: 1,
      },
    ],
  },
  LogSourceId: "slow-query",
  LogSource: {
    id: "error",
    path: "/var/log/app.log",
    stream: "stderr",
    strategy: "follow",
  },
  LogSourceInput: { path: "/var/log/app.log" },
};

export const publicSchemaHappyPathFixture = (schemaName: JsonSchemaName): unknown => {
  const override = fixtureOverrides[schemaName];
  if (override !== undefined) return override;

  const jsonSchema = getJsonSchema(schemaName) as JsonSchemaNode;
  return materializeJsonSchemaFixture(jsonSchema, jsonSchema, schemaName);
};

export const assertPublicSchemaContractCoverage = (
  repoRoot = resolve(import.meta.dirname, "../../.."),
): void => {
  const fixtureNames: string[] = Object.keys(PUBLIC_SCHEMA_CONTRACT_FIXTURES).sort();
  const registryNames: string[] = [...JSON_SCHEMA_NAMES].sort();
  if (JSON.stringify(fixtureNames) !== JSON.stringify(registryNames)) {
    throw new Error(
      `Public schema contract fixture list does not match JSON_SCHEMA_NAMES. Missing/extra: ${registryNames
        .filter((name) => !fixtureNames.includes(name))
        .concat(fixtureNames.filter((name) => !registryNames.includes(name)))
        .join(", ")}`,
    );
  }

  const missingFiles = [...new Set(Object.values(PUBLIC_SCHEMA_CONTRACT_FIXTURES))].filter(
    (testFile) => !existsSync(resolve(repoRoot, testFile)),
  );
  if (missingFiles.length > 0) {
    throw new Error(`Public schema contract test files are missing: ${missingFiles.join(", ")}`);
  }

  const failingSchemas: string[] = [];
  for (const schemaName of JSON_SCHEMA_NAMES) {
    const schema: Schema.Schema.AnyNoContext = publicSchemaRegistry[schemaName];
    const happy = Schema.decodeUnknownEither(schema)(publicSchemaHappyPathFixture(schemaName), {
      onExcessProperty: "error",
    });
    const error = Schema.decodeUnknownEither(schema)(undefined, { onExcessProperty: "error" });

    if (Either.isLeft(happy)) failingSchemas.push(`${schemaName} happy path: ${String(happy.left)}`);
    if (Either.isRight(error)) failingSchemas.push(`${schemaName} error path accepted undefined`);
    if (Either.isRight(happy)) {
      const encoded = Schema.encodeEither(schema)(happy.right);
      if (Either.isLeft(encoded)) failingSchemas.push(`${schemaName} encode: ${String(encoded.left)}`);
      if (Either.isRight(encoded)) {
        const decodedAgain = Schema.decodeUnknownEither(schema)(encoded.right, { onExcessProperty: "error" });
        if (Either.isLeft(decodedAgain))
          failingSchemas.push(`${schemaName} decode encoded: ${String(decodedAgain.left)}`);
      }
    }
  }

  if (failingSchemas.length > 0) {
    throw new Error(`Public schema contract checks failed:\n${failingSchemas.join("\n")}`);
  }
};
