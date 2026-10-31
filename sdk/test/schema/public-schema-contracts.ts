import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Result, Schema } from "effect";

import {
  JSON_SCHEMA_NAMES,
  type JsonSchemaName,
  authoringExpressionSlot,
  getJsonSchema,
  publicSchemaRegistry,
} from "../../src/schema/index.ts";

const ISO_TIMESTAMP = "2026-06-14T00:00:00.000Z";
const PUBLIC_SCHEMA_CONTRACT_TEST_FILE = "sdk/test/schema/public-schema-contracts.test.ts";
const BOOTSTRAP_EVENT_CONTRACT_TEST_FILE = "sdk/test/events/bootstrap.test.ts";
const APP_RESULTS_CONTRACT_TEST_FILE = "sdk/test/schema/app-results.test.ts";

export type PublicSchemaContractFixture = {
  readonly testFile: `sdk/test/${string}.test.ts`;
};

export const PUBLIC_SCHEMA_CONTRACT_FIXTURES = {
  CommandContribution: "sdk/test/schema/command-contribution.test.ts",
  LandofileSourceValue: "sdk/test/schema/landofile-source.test.ts",
  LandofileSourceDocument: "sdk/test/schema/landofile-source.test.ts",
  LandofileSourceProjection: "sdk/test/schema/landofile-source.test.ts",
  SecretReference: "sdk/test/schema/environment-value.test.ts",
  SecretRef: "sdk/test/schema/environment-value.test.ts",
  BoundTextReference: "sdk/test/schema/environment-value.test.ts",
  BoundText: "sdk/test/schema/environment-value.test.ts",
  EnvironmentValue: "sdk/test/schema/environment-value.test.ts",
  Environment: "sdk/test/schema/environment-value.test.ts",
  ServiceCreds: "sdk/test/schema/environment-value.test.ts",
  DatabaseConnection: "sdk/test/schema/environment-value.test.ts",
  ServiceCredsDisplay: "sdk/test/schema/environment-value.test.ts",
  CurrentExecutableAppPlan: "sdk/test/schema/app-plan.test.ts",
  EventStepPlan: "sdk/test/schema/app-plan.test.ts",
  EventStepSource: "sdk/test/schema/app-plan.test.ts",
  EventStepStatus: "sdk/test/schema/app-plan.test.ts",
  EventsPlan: "sdk/test/schema/app-plan.test.ts",
  CompilationContext: "sdk/test/schema/compiled-landofile.test.ts",
  ParsedPendingSite: "sdk/test/schema/compiled-landofile.test.ts",
  SourceCompiledLandofile: "sdk/test/schema/compiled-landofile.test.ts",
  ComposedCompiledLandofile: "sdk/test/schema/compiled-landofile.test.ts",
  LoadScopedLandofile: "sdk/test/schema/compiled-landofile.test.ts",
  IdentityScopedLandofile: "sdk/test/schema/compiled-landofile.test.ts",
  ServiceScopedLandofile: "sdk/test/schema/compiled-landofile.test.ts",
  CompiledLandofile: "sdk/test/schema/compiled-landofile.test.ts",
  SshAgentConfig: "sdk/test/schema/agent-forwarding.test.ts",
  GpgAgentConfig: "sdk/test/schema/agent-forwarding.test.ts",
  AgentSocketKind: "sdk/test/schema/agent-forwarding.test.ts",
  AgentSocketDelivery: "sdk/test/schema/agent-forwarding.test.ts",
  AgentSocketProviderCapabilities: "sdk/test/schema/agent-forwarding.test.ts",
  AgentSocketUpstream: "sdk/test/schema/agent-forwarding.test.ts",
  AgentSocketBridgeInput: "sdk/test/schema/agent-forwarding.test.ts",
  AgentSocketBridgeResult: "sdk/test/schema/agent-forwarding.test.ts",
  SecretStoreContribution: "sdk/test/schema/plugin-secret-stores.test.ts",
  LayerMergeRule: "sdk/test/schema/landofile-merge-rules.test.ts",
  HostTerminal: "sdk/test/schema/host-terminal.test.ts",
  ProviderSetupPlan: "sdk/test/schema/provider-setup-plan.test.ts",
  AppMountInput: "sdk/test/schema/named-contract-examples.test.ts",
  MountInput: "sdk/test/schema/named-contract-examples.test.ts",
  StorageInput: "sdk/test/schema/named-contract-examples.test.ts",
  CertsInput: "sdk/test/schema/named-contract-examples.test.ts",
  CaInput: "sdk/test/schema/named-contract-examples.test.ts",
  BindAddress: "sdk/test/schema/endpoint-intent.test.ts",
  PortNumber: "sdk/test/schema/endpoint-intent.test.ts",
  RouteHostname: "sdk/test/schema/hostname.test.ts",
  RoutePathPrefix: "sdk/test/schema/hostname.test.ts",
  DomainName: "sdk/test/schema/hostname.test.ts",
  InternalEndpoint: "sdk/test/schema/endpoint-intent.test.ts",
  PublishedEndpoint: "sdk/test/schema/endpoint-intent.test.ts",
  ProxyCapabilities: "sdk/test/contract/router-service.test.ts",
  RouteFilterType: "sdk/test/schema/route-filter.test.ts",
  RouteFilter: "sdk/test/schema/route-filter.test.ts",
  RouteInputError: "sdk/test/schema/route-filter.test.ts",
  RouteProviderMismatchError: "sdk/test/schema/route-provider.test.ts",
  ProxyConfig: "sdk/test/contract/router-service.test.ts",
  RouterConfig: "sdk/test/schema/router-config.test.ts",
  ProxyAuthority: "sdk/test/contract/router-service.test.ts",
  ProxyApplyResult: "sdk/test/contract/router-service.test.ts",
  ProxyStatus: "sdk/test/contract/router-service.test.ts",
  ScannerConfig: "sdk/test/schema/scanner-config.test.ts",
  ScanPlan: "sdk/test/schema/scan-plan.test.ts",
  EndpointScan: "sdk/test/schema/service-contracts.test.ts",
  ServiceFeatureValidationResult: "sdk/test/schema/service-contracts.test.ts",
  CheckResult: "sdk/test/schema/check-result.test.ts",
  AuthoredNetworkPlan: "sdk/test/schema/networking-plan.test.ts",
  ServiceNetworkAttachment: "sdk/test/schema/networking-plan.test.ts",
  NormalizedToolingFlag: "sdk/test/schema/tooling-input.test.ts",
  NormalizedToolingArg: "sdk/test/schema/tooling-input.test.ts",
  ToolingInputDeclaration: "sdk/test/schema/tooling-input.test.ts",
  ToolingInputValues: "sdk/test/schema/bun-shell-script.test.ts",
  ToolingInvocationInput: "sdk/test/schema/tooling-input.test.ts",
  ServiceConfigInput: "sdk/test/schema/service-config-compose-spellings.test.ts",
  ServiceFileConfig: "sdk/test/schema/service-file-config.test.ts",
  SqliteTargetConfig: "sdk/test/schema/sqlite-target.test.ts",
  PhpComposerConfig: "sdk/test/schema/php-composer-config.test.ts",
  LogSource: "sdk/test/schema/log-source.test.ts",
  LogSourceId: "sdk/test/schema/log-source.test.ts",
  LogSourceInput: "sdk/test/schema/named-contract-examples.test.ts",
  LogSourceStream: "sdk/test/schema/log-source.test.ts",
  LogSourceStrategy: "sdk/test/schema/log-source.test.ts",
  EndpointInput: "sdk/test/schema/named-contract-examples.test.ts",
  RouteInput: "sdk/test/schema/named-contract-examples.test.ts",
  HealthcheckInput: "sdk/test/schema/named-contract-examples.test.ts",
  RouteObjectInput: "sdk/test/schema/route-filter.test.ts",
  ToolingTaskInput: "sdk/test/schema/tooling-task-input.test.ts",
  AppEnvironmentDefaults: "sdk/test/schema/global-config-app-defaults.test.ts",
  AppLabelDefaults: "sdk/test/schema/global-config-app-defaults.test.ts",
  NotifyConfig: "sdk/test/events/notify.test.ts",
  RendererCapabilities: "sdk/test/events/notify.test.ts",
  GlobalConfigView: "sdk/test/schema/config-view.test.ts",
  HostEventCmdStep: "sdk/test/schema/host-events.test.ts",
  HostEventCommandStep: "sdk/test/schema/host-events.test.ts",
  HostEventName: "sdk/test/schema/host-events.test.ts",
  HostEventStep: "sdk/test/schema/host-events.test.ts",
  HostEvents: "sdk/test/schema/host-events.test.ts",
  LifecycleCommandId: "sdk/test/schema/host-events.test.ts",
  VolumeLocator: "sdk/test/schema/volume-identity.test.ts",
  VolumeIdentity: "sdk/test/schema/volume-identity.test.ts",
  VolumeCreationFact: "sdk/test/schema/volume-initialization.test.ts",
  VolumeInitializationRecord: "sdk/test/schema/volume-initialization.test.ts",
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
  ProviderId: "sdk/test/schema/named-contract-examples.test.ts",
  PortablePath: "sdk/test/schema/named-contract-examples.test.ts",
  CommandSpec: "sdk/test/schema/named-contract-examples.test.ts",
  ContainerUser: "sdk/test/schema/named-contract-examples.test.ts",
  ServiceInfoLogSource: "sdk/test/schema/service-info.test.ts",
  StartedService: "sdk/test/schema/service-info.test.ts",
  LandofileEventsOutcome: APP_RESULTS_CONTRACT_TEST_FILE,
  StartAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  StopAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  RestartAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  RebuildAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  DestroyAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  InfoAppAgentEnv: APP_RESULTS_CONTRACT_TEST_FILE,
  InfoAppHostProxy: APP_RESULTS_CONTRACT_TEST_FILE,
  InfoAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  ExecAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  ToolingResult: APP_RESULTS_CONTRACT_TEST_FILE,
  AppRemoteEntry: APP_RESULTS_CONTRACT_TEST_FILE,
  AppRemoteMutationResult: APP_RESULTS_CONTRACT_TEST_FILE,
  ShareStopAppResult: APP_RESULTS_CONTRACT_TEST_FILE,
  EndpointRef: "sdk/test/schema/endpoint-foundation.test.ts",
  ObservedPublication: "sdk/test/schema/endpoint-foundation.test.ts",
  PublicationObservation: "sdk/test/schema/endpoint-foundation.test.ts",
  EndpointInvariantIssue: "sdk/test/schema/endpoint-foundation.test.ts",
  HttpEndpointSelection: "sdk/test/schema/endpoint-foundation.test.ts",
  LogicalEndpoint: "sdk/test/schema/endpoint-foundation.test.ts",
  ServiceConnection: "sdk/test/schema/endpoint-foundation.test.ts",
  ServiceState: "sdk/test/schema/service-info.test.ts",
  RouteEvidence: "sdk/test/contract/router-service.test.ts",
  PluginDoctorReport: "sdk/test/schema/plugin-doctor.test.ts",
  PluginStateLockOptions: "sdk/test/schema/plugin-state-lock-options.test.ts",
  RouterServiceContribution: "sdk/test/contract/router-service.test.ts",
  PreparedFileSyncTarget: "sdk/test/schema/prepared-file-sync-target.test.ts",
  FileSyncInfo: "sdk/test/schema/file-sync-info.test.ts",
  FileSyncPolicy: "sdk/test/schema/file-sync-info.test.ts",
  FileSyncPolicyInfo: "sdk/test/schema/file-sync-info.test.ts",
  FileSyncPolicyReason: "sdk/test/schema/file-sync-info.test.ts",
  FileSyncServicePolicy: "sdk/test/schema/file-sync-info.test.ts",
  RecipeSource: "sdk/test/recipes/source-compiler.test.ts",
  RecipeSourceOption: "sdk/test/recipes/source-options.test.ts",
  RecipeSourcePrompt: "sdk/test/recipes/source-options.test.ts",
  RecipeConfigLayer: "sdk/test/recipes/source-compiler.test.ts",
  RecipeSourceCompileContext: "sdk/test/recipes/source-compiler.test.ts",
  UpdateChannel: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestPlatform: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestHttpsUrl: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestSemver: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestSha256: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestBinary: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestBinaries: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestChecksums: "sdk/test/schema/update-manifest.test.ts",
  UpdateManifestSchema: "sdk/test/schema/update-manifest.test.ts",
  PreBootstrapMinimalEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapMinimalEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PreBootstrapPluginsEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapPluginsEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PreBootstrapCommandsEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapCommandsEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PreBootstrapProviderEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapProviderEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PreBootstrapAppEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapAppEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PreBootstrapToolingEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapToolingEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
  PostBootstrapEvent: BOOTSTRAP_EVENT_CONTRACT_TEST_FILE,
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
  CliCommandInitEvent: "sdk/test/events/cli.test.ts",
  CliCommandRunEvent: "sdk/test/events/cli.test.ts",
  CliCommandErrorEvent: "sdk/test/events/cli.test.ts",
  NotifyDesktopEvent: "sdk/test/events/notify.test.ts",
  CommandInvocationCorrelation: "sdk/test/events/notify.test.ts",
  CodeSnippetEvent: "sdk/test/schema/renderer-41-freeze.test.ts",
  DiffRenderEvent: "sdk/test/schema/renderer-41-freeze.test.ts",
  MarkdownBlockEvent: "sdk/test/schema/renderer-41-freeze.test.ts",
  RenderEvent: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererPanelSlot: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererPanelId: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererPanelWatch: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererPanelManifestEntry: "sdk/test/schema/renderer-41-freeze.test.ts",
  StyledSpanTone: "sdk/test/schema/renderer-41-freeze.test.ts",
  StyledSpan: "sdk/test/schema/renderer-41-freeze.test.ts",
  PanelView: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererPanelSize: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererPanelContext: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererActionId: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererKeyName: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererKeyChord: "sdk/test/schema/renderer-41-freeze.test.ts",
  RendererKeyBinding: "sdk/test/schema/renderer-41-freeze.test.ts",
  KeymapConfig: "sdk/test/schema/renderer-41-freeze.test.ts",
  KeymapConflictError: "sdk/test/schema/renderer-41-freeze.test.ts",
  SubscriberSelector: "sdk/test/schema/renderer-41-freeze.test.ts",
  SubscriberManifestEntry: "sdk/test/schema/renderer-41-freeze.test.ts",
  PublishedGlobalConfigKey: "sdk/test/schema/renderer-41-freeze.test.ts",
  FailureRole: "sdk/test/command-result-roles.test.ts",
  CommandCompletion: "sdk/test/schema/command-completion-output.test.ts",
  CommandOutput: "sdk/test/schema/command-completion-output.test.ts",
  CommandOutputChunk: "sdk/test/schema/command-completion-output.test.ts",
  CommandTraceSpan: "sdk/test/schema/command-trace.test.ts",
  CommandTrace: "sdk/test/schema/command-trace.test.ts",
  TracingConfig: "sdk/test/schema/command-trace.test.ts",
  DotnetServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  LocalStackServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  MailhogServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  MailpitServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  MinIOServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  MssqlServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  MysqlServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  PhpMyAdminServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  PhpServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  RabbitMQServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  TomcatServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
  VarnishServiceConfig: "sdk/test/schema/catalog-service-configs.test.ts",
} satisfies Partial<Record<JsonSchemaName, PublicSchemaContractFixture["testFile"]>>;

export const publicSchemaContractTestFile = (
  schemaName: JsonSchemaName,
): PublicSchemaContractFixture["testFile"] => {
  const overrides: Partial<Record<JsonSchemaName, PublicSchemaContractFixture["testFile"]>> =
    PUBLIC_SCHEMA_CONTRACT_FIXTURES;
  return overrides[schemaName] ?? PUBLIC_SCHEMA_CONTRACT_TEST_FILE;
};

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
    const { allOf, ...base } = resolved;
    const baseValue = materializeJsonSchemaFixture(root, base, key);
    const values = allOf.map((child) => materializeJsonSchemaFixture(root, child, key));
    if (baseValue !== null && typeof baseValue === "object" && !Array.isArray(baseValue)) {
      return mergeObjects([baseValue, ...values]);
    }
    return baseValue ?? values.find((value) => value !== null) ?? null;
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

const documentSetFixture = {
  _tag: "landofile-document-set",
  documents: [],
  mode: "full",
  selectedSourceIds: [],
  currentLowerV4Fragments: [],
  writableLayerIds: ["canonical"],
} as const;

const recipeProducerFixture = {
  sourceKind: "bundled",
  packageName: "@lando/recipe-demo",
  recipeId: "demo",
  manifestVersion: "1.0.0",
  contentDigest: `sha256:${"a".repeat(64)}`,
} as const;

const recipeSnapshotFixture = {
  identity: recipeProducerFixture,
  optionTypes: { php: { kind: "string" } },
  defaults: { php: "8.3" },
  template: { expression: { kind: "Literal", value: "8.3" } },
  assets: [],
} as const;

const recipeProvenanceFixture = {
  id: "demo",
  version: "1.0.0",
  producer: recipeProducerFixture,
  options: { php: "8.3" },
} as const;

const fixtureOverrides: Partial<Record<JsonSchemaName, unknown>> = {
  SqliteTargetConfig: { path: "data/site.sqlite" },
  RecipeSourceCompileContext: { sourceKind: "local", packageName: "example", assets: [] },
  ContainerHelperArch: "x64",
  ContainerHelperTarget: { os: "linux", arch: "arm64" },
  ContainerHelperDigest: "a".repeat(64),
  ContainerHelperArtifact: {
    target: { os: "linux", arch: "x64" },
    digest: "b".repeat(64),
    path: "/tmp/lando-container-helper",
  },
  GuideProps: {},
  CleanupProps: {},
  RouteFilter: { type: "stripPrefix", prefix: "/api" },
  RecipeSourceKind: "bundled",
  RecipeContentDigest: `sha256:${"a".repeat(64)}`,
  RecipeOptionValue: "8.3",
  RecipeServiceMap: { appserver: "web" },
  RecipeProducer: recipeProducerFixture,
  LandofileRecipeProvenance: recipeProvenanceFixture,
  LandofileRecipeField: "demo",
  RecipeOptionType: { kind: "boolean" },
  RecipeSnapshotAsset: { dest: ".lando.yml", digest: `sha256:${"b".repeat(64)}` },
  RecipeSnapshot: recipeSnapshotFixture,
  RecipeHunkKind: "add",
  RecipeHunkClassification: "selected",
  RecipeMigrationHunk: {
    id: `hunk-${"0".repeat(24)}`,
    kind: "add",
    layer: "canonical",
    path: "services.web",
    new: {},
  },
  RecipeMigration: {
    from: recipeProducerFixture,
    to: { ...recipeProducerFixture, manifestVersion: "1.1.0" },
    fromSnapshot: recipeSnapshotFixture,
    toSnapshot: {
      ...recipeSnapshotFixture,
      identity: { ...recipeProducerFixture, manifestVersion: "1.1.0" },
    },
    hunks: [],
  },
  RecipeDecomposeInput: { producer: recipeProducerFixture, options: { php: "8.3" }, secrets: {} },
  RecipeDecomposeResult: { fragment: {}, provenance: recipeProvenanceFixture },
  ConfigTranslateSecretReference: { disposition: "secret-store", reference: "${secret:API_KEY}" },

  AuthoringExpression: Schema.decodeUnknownSync(authoringExpressionSlot("string"))("{{ env.NAME }}"),
  ConfigTranslateDocumentBytes: "bmFtZTogZGVtbwo=",
  ConfigTranslateDocument: {
    sourceId: "lando.yml",
    layerId: "canonical",
    mediaType: "application/yaml",
    contentDigest: `sha256:${"a".repeat(64)}`,
    bytes: "bmFtZTogZGVtbwo=",
  },
  ConfigTranslateDocumentSetInput: documentSetFixture,
  ConfigTranslateInput: documentSetFixture,
  ConfigTranslateDetectInput: { documents: [] },
  CliCommandInitEvent: {
    _tag: "cli-meta:version-init",
    commandId: "meta:version",
    argv: ["version"],
    args: {},
    flags: {},
    cwd: "/tmp/lando-app",
    invocationId: "01jbtestouterinvocation0001",
    timestamp: ISO_TIMESTAMP,
  },
  CliCommandRunEvent: {
    _tag: "cli-meta:version-run",
    commandId: "meta:version",
    argv: ["version"],
    args: {},
    flags: {},
    cwd: "/tmp/lando-app",
    invocationId: "01jbtestouterinvocation0001",
    timestamp: ISO_TIMESTAMP,
    exitCode: 0,
    durationMs: 1,
  },
  CliCommandErrorEvent: {
    _tag: "cli-meta:version-error",
    commandId: "meta:version",
    argv: ["version"],
    args: {},
    flags: {},
    cwd: "/tmp/lando-app",
    invocationId: "01jbtestouterinvocation0001",
    timestamp: ISO_TIMESTAMP,
    exitCode: 1,
    durationMs: 1,
    failureTag: "Defect",
  },
  NotifyDesktopEvent: {
    _tag: "notify.desktop",
    title: "Build complete",
    body: "app:start finished",
    urgency: "success",
  },
  CommandInvocationCorrelation: {
    invocationId: "01jbtestouterinvocation0001",
  },
  NotifyConfig: {
    enabled: true,
    thresholdMs: 15000,
    commands: [],
  },
  RendererCapabilities: {
    color: false,
    interactive: true,
    animation: true,
    notifications: false,
  },
  CodeSnippetEvent: {
    _tag: "code.snippet",
    code: "const x = 1",
    language: "ts",
    startLine: 1,
    highlightLines: [1],
  },
  DiffRenderEvent: {
    _tag: "diff.render",
    unified: "--- a\n+++ b\n",
  },
  MarkdownBlockEvent: {
    _tag: "markdown.block",
    markdown: "# title",
  },
  RenderEvent: {
    _tag: "notify.desktop",
    title: "done",
  },
  RendererPanelSlot: "status-bar",
  RendererPanelId: "build-status",
  RendererPanelWatch: ["post-start"],
  RendererPanelManifestEntry: {
    id: "build-status",
    slot: "status-bar",
    watch: ["post-start"],
    module: "./panels/status.ts",
  },
  StyledSpanTone: "default",
  StyledSpan: { text: "ok", tone: "default", bold: false, dim: false, italic: false, underline: false },
  PanelView: [[{ text: "ok", tone: "default", bold: false, dim: false, italic: false, underline: false }]],
  RendererPanelSize: { columns: 80, rows: 1 },
  RendererPanelContext: {
    size: { columns: 80, rows: 1 },
    event: { _tag: "message.info", body: "panel", timestamp: ISO_TIMESTAMP },
  },
  RendererActionId: "tree.expand",
  RendererKeyName: "enter",
  RendererKeyChord: "ctrl+alt+shift+f",
  RendererKeyBinding: ["enter", "space"],
  KeymapConfig: {
    "tree.expand": "space",
    "viewer.quit": ["q", "ctrl+d"],
  },
  KeymapConflictError: {
    _tag: "KeymapConflictError",
    surface: "task-tree",
    chord: "enter",
    actions: ["tree.collapse", "tree.expand"],
    message: "chord enter collides",
    remediation: "change one binding",
  },
  SubscriberSelector: { family: "cli-command-terminal" },
  SubscriberManifestEntry: {
    id: "notify-on-command-terminal",
    selectors: [{ family: "cli-command-terminal" }],
    module: "./src/subscribers/notify.ts",
    priority: 900,
    abortOnError: false,
    configKey: "notify",
  },
  PublishedGlobalConfigKey: "notify",
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
  LogSourceInput: { path: "/var/log/app.log", timestamps: true },
  MountInput: "./src:/app",
  StorageInput: "/data",
  CertsInput: true,
  CaInput: "./certs/corp-ca.pem",
  ContainerUser: "www-data",
  EndpointInput: { _tag: "internal", protocol: "http", port: 8080 },
  RouteInput: "appserver.lndo.site",
  HealthcheckInput: "pg_isready",
  CommandSpec: "npm start",
  CommandContribution: { id: "db:inspect", summary: "Inspect the database." },
  PortablePath: "/app",
  ProviderId: "lando",
  BindAddress: "127.0.0.1",
  ObservedPublication: { port: 8080, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 49152 },
  PortNumber: 8080,
  RouteHostname: "*.app.lndo.site",
  RoutePathPrefix: "/api",
  DomainName: "lando.test",
  InternalEndpoint: { _tag: "internal", protocol: "http", port: 8080 },
  PublishedEndpoint: { _tag: "published", protocol: "http", port: 8080, publication: {} },
  CommandTraceSpan: {
    id: "root",
    name: "lando meta:config",
    startOffsetMs: 0,
    durationMs: 1,
    status: "ok",
    attributes: { "lando.command.id": "meta:config" },
  },
  CommandTrace: {
    totalDurationMs: 1,
    spans: [
      {
        id: "root",
        name: "lando meta:config",
        startOffsetMs: 0,
        durationMs: 1,
        status: "ok",
        attributes: { "lando.command.id": "meta:config" },
      },
    ],
    droppedSpans: 0,
  },
  TracingConfig: {
    otlp: {
      endpoint: "http://localhost:4318",
      headers: { Authorization: "Bearer token" },
    },
  },
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
  const registryNames: ReadonlySet<string> = new Set(JSON_SCHEMA_NAMES);
  const unknownNames = Object.keys(PUBLIC_SCHEMA_CONTRACT_FIXTURES).filter(
    (name) => !registryNames.has(name),
  );
  if (unknownNames.length > 0) {
    throw new Error(`Unknown public schema contract fixture overrides: ${unknownNames.join(", ")}`);
  }

  const missingFiles = [...new Set(JSON_SCHEMA_NAMES.map(publicSchemaContractTestFile))].filter(
    (testFile) => !existsSync(resolve(repoRoot, testFile)),
  );
  if (missingFiles.length > 0) {
    throw new Error(`Public schema contract test files are missing: ${missingFiles.join(", ")}`);
  }

  const failingSchemas: string[] = [];
  for (const schemaName of JSON_SCHEMA_NAMES) {
    const schema: Schema.Codec<unknown, unknown> = Schema.make(publicSchemaRegistry[schemaName].ast);
    const happy = Schema.decodeUnknownResult(schema)(publicSchemaHappyPathFixture(schemaName), {
      onExcessProperty: "error",
    });
    const error = Schema.decodeUnknownResult(schema)(undefined, { onExcessProperty: "error" });

    if (Result.isFailure(happy)) failingSchemas.push(`${schemaName} happy path: ${String(happy.failure)}`);
    if (Result.isSuccess(error)) failingSchemas.push(`${schemaName} error path accepted undefined`);
    if (Result.isSuccess(happy)) {
      const encoded = Schema.encodeResult(schema)(happy.success);
      if (Result.isFailure(encoded)) failingSchemas.push(`${schemaName} encode: ${String(encoded.failure)}`);
      if (Result.isSuccess(encoded)) {
        const decodedAgain = Schema.decodeUnknownResult(schema)(encoded.success, {
          onExcessProperty: "error",
        });
        if (Result.isFailure(decodedAgain))
          failingSchemas.push(`${schemaName} decode encoded: ${String(decodedAgain.failure)}`);
      }
    }
  }

  if (failingSchemas.length > 0) {
    throw new Error(`Public schema contract checks failed:\n${failingSchemas.join("\n")}`);
  }
};
