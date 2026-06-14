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

export type PublicSchemaContractFixture = {
  readonly testFile: `sdk/test/schema/${string}.test.ts`;
};

export const PUBLIC_SCHEMA_CONTRACT_FIXTURES = {
  DeprecationNotice: "sdk/test/schema/public-schema-contracts.test.ts",
  DeprecationUse: "sdk/test/schema/public-schema-contracts.test.ts",
  LandofileExpressionParseError: "sdk/test/schema/public-schema-contracts.test.ts",
  LandofileExpressionForbiddenError: "sdk/test/schema/public-schema-contracts.test.ts",
  LandofileExpressionEvalError: "sdk/test/schema/public-schema-contracts.test.ts",
  GuideFrontmatter: "sdk/test/schema/public-schema-contracts.test.ts",
  GuideProps: "sdk/test/schema/public-schema-contracts.test.ts",
  ScenarioProps: "sdk/test/schema/public-schema-contracts.test.ts",
  StepProps: "sdk/test/schema/public-schema-contracts.test.ts",
  RunProps: "sdk/test/schema/public-schema-contracts.test.ts",
  VerifyProps: "sdk/test/schema/public-schema-contracts.test.ts",
  CleanupProps: "sdk/test/schema/public-schema-contracts.test.ts",
  VariableProps: "sdk/test/schema/public-schema-contracts.test.ts",
  HiddenProps: "sdk/test/schema/public-schema-contracts.test.ts",
  InspectProps: "sdk/test/schema/public-schema-contracts.test.ts",
  TabsProps: "sdk/test/schema/public-schema-contracts.test.ts",
  TabProps: "sdk/test/schema/public-schema-contracts.test.ts",
  InlineProps: "sdk/test/schema/public-schema-contracts.test.ts",
  SkipProps: "sdk/test/schema/public-schema-contracts.test.ts",
  UseFixtureProps: "sdk/test/schema/public-schema-contracts.test.ts",
  MatcherSchema: "sdk/test/schema/public-schema-contracts.test.ts",
  Transcript: "sdk/test/schema/public-schema-contracts.test.ts",
  PublicTranscript: "sdk/test/schema/public-schema-contracts.test.ts",
  ExpressionNode: "sdk/test/schema/public-schema-contracts.test.ts",
  ExpressionTemplate: "sdk/test/schema/public-schema-contracts.test.ts",
  BootstrapLevel: "sdk/test/schema/public-schema-contracts.test.ts",
  HostArchitecture: "sdk/test/schema/public-schema-contracts.test.ts",
  AppRef: "sdk/test/schema/public-schema-contracts.test.ts",
  ArtifactRef: "sdk/test/schema/public-schema-contracts.test.ts",
  ArtifactBuildSpec: "sdk/test/schema/public-schema-contracts.test.ts",
  BuildScript: "sdk/test/schema/public-schema-contracts.test.ts",
  BuildPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  BuildStep: "sdk/test/schema/public-schema-contracts.test.ts",
  AppPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  ServicePlan: "sdk/test/schema/public-schema-contracts.test.ts",
  AppMountPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  MountPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  DataStorePlan: "sdk/test/schema/public-schema-contracts.test.ts",
  DataStoreMountPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  StorageScope: "sdk/test/schema/public-schema-contracts.test.ts",
  EndpointPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  RouteRef: "sdk/test/schema/public-schema-contracts.test.ts",
  RoutePlan: "sdk/test/schema/public-schema-contracts.test.ts",
  HealthcheckPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  CertificatePlan: "sdk/test/schema/public-schema-contracts.test.ts",
  HostAliasPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  DependencyPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  NetworkPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  PerAppBridgePlan: "sdk/test/schema/public-schema-contracts.test.ts",
  SharedNetworkMembershipPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  NetworkingPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  IsolateMode: "sdk/test/schema/public-schema-contracts.test.ts",
  ProviderCapabilities: "sdk/test/schema/public-schema-contracts.test.ts",
  LandofileShape: "sdk/test/schema/public-schema-contracts.test.ts",
  ServiceConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  EndpointInput: "sdk/test/schema/public-schema-contracts.test.ts",
  RouteInput: "sdk/test/schema/public-schema-contracts.test.ts",
  HealthcheckInput: "sdk/test/schema/public-schema-contracts.test.ts",
  ToolingVar: "sdk/test/schema/public-schema-contracts.test.ts",
  ToolingFlagShape: "sdk/test/schema/public-schema-contracts.test.ts",
  ToolingArgShape: "sdk/test/schema/public-schema-contracts.test.ts",
  ToolingTaskShape: "sdk/test/schema/public-schema-contracts.test.ts",
  IncludeEntry: "sdk/test/schema/public-schema-contracts.test.ts",
  TelemetryConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  NetworkProxyConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  NetworkCaConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  NetworkConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  GlobalConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  ConfigLintViolation: "sdk/test/schema/public-schema-contracts.test.ts",
  ConfigLintResult: "sdk/test/schema/public-schema-contracts.test.ts",
  AppId: "sdk/test/schema/public-schema-contracts.test.ts",
  ServiceName: "sdk/test/schema/public-schema-contracts.test.ts",
  ProviderId: "sdk/test/schema/public-schema-contracts.test.ts",
  PluginName: "sdk/test/schema/public-schema-contracts.test.ts",
  PortablePath: "sdk/test/schema/public-schema-contracts.test.ts",
  CommandSpec: "sdk/test/schema/public-schema-contracts.test.ts",
  PlanMetadata: "sdk/test/schema/public-schema-contracts.test.ts",
  ProviderExtensionConfig: "sdk/test/schema/public-schema-contracts.test.ts",
  HostPlatform: "sdk/test/schema/public-schema-contracts.test.ts",
  ServiceInfo: "sdk/test/schema/public-schema-contracts.test.ts",
  EmbeddingPluginPolicy: "sdk/test/schema/public-schema-contracts.test.ts",
  ContributionRef: "sdk/test/schema/public-schema-contracts.test.ts",
  PluginSetupFlagContribution: "sdk/test/schema/public-schema-contracts.test.ts",
  PluginSetupContribution: "sdk/test/schema/public-schema-contracts.test.ts",
  PluginContribution: "sdk/test/schema/public-schema-contracts.test.ts",
  PluginManifest: "sdk/test/schema/public-schema-contracts.test.ts",
  PluginTrustState: "sdk/test/schema/public-schema-contracts.test.ts",
  GlobalServiceContribution: "sdk/test/schema/public-schema-contracts.test.ts",
  FileSyncEngineCapabilities: "sdk/test/schema/public-schema-contracts.test.ts",
  FileSyncSessionSpec: "sdk/test/schema/public-schema-contracts.test.ts",
  FileSyncSessionInfo: "sdk/test/schema/public-schema-contracts.test.ts",
  FileSyncEventChunk: "sdk/test/schema/public-schema-contracts.test.ts",
  FileSyncPlan: "sdk/test/schema/public-schema-contracts.test.ts",
  RecipeChoicesFrom: "sdk/test/schema/public-schema-contracts.test.ts",
  RecipeManifest: "sdk/test/schema/public-schema-contracts.test.ts",
  RecipeRegistryResolution: "sdk/test/schema/public-schema-contracts.test.ts",
  RecipeRegistryResponse: "sdk/test/schema/public-schema-contracts.test.ts",
  TemplateRenderContext: "sdk/test/schema/public-schema-contracts.test.ts",
  LandoEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreBootstrapEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostBootstrapEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  ReadyEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  BeforeExitEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreInitEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostInitEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreRebuildEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostRebuildEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreDestroyEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostDestroyEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreGlobalStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostGlobalStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreGlobalStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostGlobalStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreAppStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostAppStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreAppStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostAppStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreServiceStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostServiceStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreServiceStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostServiceStopEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreBuildEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostBuildEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreProviderApplyEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostProviderApplyEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PreProviderExecEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PostProviderExecEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  CliCommandInitEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  CliCommandRunEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  CliCommandErrorEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  DeprecationUsedEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskTreeStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskStartEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskDetailEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskDetailExpandEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskDetailCollapseEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskCompleteEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskFailEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  TaskTreeCompleteEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  MessageInfoEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  MessageWarnEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  MessageErrorEvent: "sdk/test/schema/public-schema-contracts.test.ts",
  PaintBannerEvent: "sdk/test/schema/public-schema-contracts.test.ts",
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
    /^(timestamp|resolvedAt|startedAt|finishedAt|lastUpdatedAt)$/i.test(key)
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
};

export const publicSchemaHappyPathFixture = (schemaName: JsonSchemaName): unknown =>
  fixtureOverrides[schemaName] ??
  materializeJsonSchemaFixture(
    getJsonSchema(schemaName) as JsonSchemaNode,
    getJsonSchema(schemaName) as JsonSchemaNode,
    schemaName,
  );

export const assertPublicSchemaContractCoverage = (
  repoRoot = resolve(import.meta.dirname, "../../.."),
): void => {
  const fixtureNames = Object.keys(PUBLIC_SCHEMA_CONTRACT_FIXTURES).sort();
  const registryNames = [...JSON_SCHEMA_NAMES].sort();
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
    const schema = publicSchemaRegistry[schemaName];
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
