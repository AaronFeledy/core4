import { JSONSchema } from "effect";

import {
  CleanupProps,
  GuideProps,
  HiddenProps,
  InlineProps,
  InspectProps,
  MatcherSchema,
  RunProps,
  ScenarioProps,
  SkipProps,
  StepProps,
  TabProps,
  TabsProps,
  UseFixtureProps,
  VariableProps,
  VerifyProps,
} from "../docs/components/props.ts";
import { GuideFrontmatter } from "../docs/guide-frontmatter.ts";
import { Transcript } from "../docs/transcript.ts";
import {
  LandofileExpressionEvalError,
  LandofileExpressionForbiddenError,
  LandofileExpressionParseError,
} from "../errors/index.ts";
import {
  CliCommandErrorEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  DeprecationUsedEvent,
  LandoEvent,
  MessageErrorEvent,
  MessageInfoEvent,
  MessageWarnEvent,
  PaintBannerEvent,
  PostAppStartEvent,
  PostAppStopEvent,
  PostBootstrapEvent,
  PostBuildEvent,
  PostDestroyEvent,
  PostGlobalStartEvent,
  PostGlobalStopEvent,
  PostInitEvent,
  PostProviderApplyEvent,
  PostProviderExecEvent,
  PostRebuildEvent,
  PostServiceStartEvent,
  PostServiceStopEvent,
  PostStartEvent,
  PostStopEvent,
  PreAppStartEvent,
  PreAppStopEvent,
  PreBootstrapEvent,
  PreBuildEvent,
  PreDestroyEvent,
  PreGlobalStartEvent,
  PreGlobalStopEvent,
  PreInitEvent,
  PreProviderApplyEvent,
  PreProviderExecEvent,
  PreRebuildEvent,
  PreServiceStartEvent,
  PreServiceStopEvent,
  PreStartEvent,
  PreStopEvent,
  ReadyEvent,
  TaskCompleteEvent,
  TaskDetailCollapseEvent,
  TaskDetailEvent,
  TaskDetailExpandEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "../events/index.ts";
import {
  AccessExpressionNode,
  ArrayLiteralExpressionNode,
  CallExpressionNode,
  ConditionalExpressionNode,
  ExpressionNode,
  ExpressionTemplate,
  LiteralExpressionNode,
  ObjectLiteralExpressionNode,
  PathExpressionNode,
} from "../expressions/ast.ts";
import { AppPlan, FileSyncPlan, ServicePlan } from "./app-plan.ts";
import { ArtifactBuildSpec, ArtifactRef, BuildScript } from "./artifacts.ts";
import { BuildPlan, BuildStep } from "./build-plan.ts";
import { ConfigLintResult, ConfigLintViolation } from "./config-lint.ts";
import {
  GlobalConfig,
  NetworkCaConfig,
  NetworkConfig,
  NetworkProxyConfig,
  TelemetryConfig,
} from "./config.ts";
import { DeprecationNotice, DeprecationNoticeJsonShape, DeprecationUse } from "./deprecation.ts";
import {
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionInfo,
  FileSyncSessionSpec,
} from "./file-sync-engine.ts";
import { getJsonSchemaWithDeprecations } from "./json-schema-deprecations.ts";
import {
  EndpointInput,
  HealthcheckInput,
  IncludeEntry,
  LandofileShape,
  RouteInput,
  ServiceConfig,
  ToolingArgShape,
  ToolingFlagShape,
  ToolingTaskShape,
  ToolingVar,
} from "./landofile.ts";
import { AppMountPlan, DataStoreMountPlan, DataStorePlan, MountPlan, StorageScope } from "./mounts.ts";
import {
  AppRef,
  CertificatePlan,
  DependencyPlan,
  EndpointPlan,
  HealthcheckPlan,
  HostAliasPlan,
  IsolateMode,
  NetworkPlan,
  NetworkingPlan,
  PerAppBridgePlan,
  ProviderCapabilities,
  RoutePlan,
  RouteRef,
  SharedNetworkMembershipPlan,
} from "./networking.ts";
import { PluginTrustState } from "./plugin-trust.ts";
import {
  ContributionRef,
  EmbeddingPluginPolicy,
  GlobalServiceContribution,
  PluginContribution,
  PluginManifest,
  PluginSetupContribution,
  PluginSetupFlagContribution,
} from "./plugin.ts";
import {
  AppId,
  BootstrapLevel,
  CommandSpec,
  HostArchitecture,
  HostPlatform,
  PlanMetadata,
  PluginName,
  PortablePath,
  ProviderExtensionConfig,
  ProviderId,
  ServiceName,
} from "./primitives.ts";
import {
  RecipeChoicesFrom,
  RecipeManifest,
  RecipeRegistryResolution,
  RecipeRegistryResponse,
} from "./recipe.ts";
import { ServiceInfo } from "./service-info.ts";
import { TemplateRenderContext } from "./template.ts";

export {
  assertJsonSchemaDeprecationsValid,
  getJsonSchemaWithDeprecations,
  renderSchemaReferenceMarkdown,
  schemaDeprecationsFromJsonSchema,
  withSchemaDeprecations,
} from "./json-schema-deprecations.ts";

type JsonObject = Record<string, unknown>;

const JSON_SCHEMA_REGISTRY = {
  DeprecationNotice,
  DeprecationUse,
  LandofileExpressionParseError,
  LandofileExpressionForbiddenError,
  LandofileExpressionEvalError,
  GuideFrontmatter,
  GuideProps,
  ScenarioProps,
  StepProps,
  RunProps,
  VerifyProps,
  CleanupProps,
  VariableProps,
  HiddenProps,
  InspectProps,
  TabsProps,
  TabProps,
  InlineProps,
  SkipProps,
  UseFixtureProps,
  MatcherSchema,
  Transcript,
  ExpressionNode,
  ExpressionTemplate,
  BootstrapLevel,
  HostArchitecture,
  AppRef,
  ArtifactRef,
  ArtifactBuildSpec,
  BuildScript,
  BuildPlan,
  BuildStep,
  AppPlan,
  ServicePlan,
  AppMountPlan,
  MountPlan,
  DataStorePlan,
  DataStoreMountPlan,
  StorageScope,
  EndpointPlan,
  RouteRef,
  RoutePlan,
  HealthcheckPlan,
  CertificatePlan,
  HostAliasPlan,
  DependencyPlan,
  NetworkPlan,
  PerAppBridgePlan,
  SharedNetworkMembershipPlan,
  NetworkingPlan,
  IsolateMode,
  ProviderCapabilities,
  LandofileShape,
  ServiceConfig,
  EndpointInput,
  RouteInput,
  HealthcheckInput,
  ToolingVar,
  ToolingFlagShape,
  ToolingArgShape,
  ToolingTaskShape,
  IncludeEntry,
  TelemetryConfig,
  NetworkProxyConfig,
  NetworkCaConfig,
  NetworkConfig,
  GlobalConfig,
  ConfigLintViolation,
  ConfigLintResult,
  AppId,
  ServiceName,
  ProviderId,
  PluginName,
  PortablePath,
  CommandSpec,
  PlanMetadata,
  ProviderExtensionConfig,
  HostPlatform,
  ServiceInfo,
  EmbeddingPluginPolicy,
  ContributionRef,
  PluginSetupFlagContribution,
  PluginSetupContribution,
  PluginContribution,
  PluginManifest,
  PluginTrustState,
  GlobalServiceContribution,
  FileSyncEngineCapabilities,
  FileSyncSessionSpec,
  FileSyncSessionInfo,
  FileSyncEventChunk,
  FileSyncPlan,
  RecipeChoicesFrom,
  RecipeManifest,
  RecipeRegistryResolution,
  RecipeRegistryResponse,
  TemplateRenderContext,
  LandoEvent,
  PreBootstrapEvent,
  PostBootstrapEvent,
  ReadyEvent,
  PreInitEvent,
  PostInitEvent,
  PreStartEvent,
  PostStartEvent,
  PreStopEvent,
  PostStopEvent,
  PreRebuildEvent,
  PostRebuildEvent,
  PreDestroyEvent,
  PostDestroyEvent,
  PreGlobalStartEvent,
  PostGlobalStartEvent,
  PreGlobalStopEvent,
  PostGlobalStopEvent,
  PreAppStartEvent,
  PostAppStartEvent,
  PreAppStopEvent,
  PostAppStopEvent,
  PreServiceStartEvent,
  PostServiceStartEvent,
  PreServiceStopEvent,
  PostServiceStopEvent,
  PreBuildEvent,
  PostBuildEvent,
  PreProviderApplyEvent,
  PostProviderApplyEvent,
  PreProviderExecEvent,
  PostProviderExecEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  CliCommandErrorEvent,
  DeprecationUsedEvent,
  TaskTreeStartEvent,
  TaskStartEvent,
  TaskDetailEvent,
  TaskDetailExpandEvent,
  TaskDetailCollapseEvent,
  TaskCompleteEvent,
  TaskFailEvent,
  TaskTreeCompleteEvent,
  MessageInfoEvent,
  MessageWarnEvent,
  MessageErrorEvent,
  PaintBannerEvent,
} as const;

export type JsonSchemaName = keyof typeof JSON_SCHEMA_REGISTRY;
export const JSON_SCHEMA_NAMES = Object.keys(JSON_SCHEMA_REGISTRY) as ReadonlyArray<JsonSchemaName>;

const landofileJsonSchema = (): JsonObject => {
  const schema = getJsonSchemaWithDeprecations(LandofileShape) as JsonObject;
  schema.additionalProperties = false;
  schema.patternProperties = {
    "^x-": {
      $id: "/schemas/unknown",
      title: "unknown",
    },
  };
  schema.propertyNames = undefined;
  return schema;
};

const expressionNodeDefinitions = () => {
  const placeholder = { ExpressionNode: { anyOf: [] } };
  const options = { definitions: placeholder } satisfies Parameters<typeof JSONSchema.fromAST>[1];
  return {
    ExpressionNode: {
      anyOf: [
        JSONSchema.fromAST(LiteralExpressionNode.ast, options),
        JSONSchema.fromAST(ArrayLiteralExpressionNode.ast, options),
        JSONSchema.fromAST(ObjectLiteralExpressionNode.ast, options),
        JSONSchema.fromAST(PathExpressionNode.ast, options),
        JSONSchema.fromAST(AccessExpressionNode.ast, options),
        JSONSchema.fromAST(CallExpressionNode.ast, options),
        JSONSchema.fromAST(ConditionalExpressionNode.ast, options),
      ],
    },
  } satisfies Parameters<typeof JSONSchema.fromAST>[1]["definitions"];
};

const expressionJsonSchema = (schemaName: "ExpressionNode" | "ExpressionTemplate") => {
  const schema = schemaName === "ExpressionNode" ? ExpressionNode : ExpressionTemplate;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $defs: expressionNodeDefinitions(),
    ...JSONSchema.fromAST(schema.ast, { definitions: expressionNodeDefinitions() }),
  };
};

export const getJsonSchema = (schemaName: JsonSchemaName) => {
  if (schemaName === "DeprecationNotice") return getJsonSchemaWithDeprecations(DeprecationNoticeJsonShape);
  if (schemaName === "LandofileShape") return landofileJsonSchema();
  if (schemaName === "ExpressionNode" || schemaName === "ExpressionTemplate")
    return expressionJsonSchema(schemaName);
  return getJsonSchemaWithDeprecations(JSON_SCHEMA_REGISTRY[schemaName]);
};
