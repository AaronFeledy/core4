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
import { PublicTranscript, Transcript } from "../docs/transcript.ts";
import { AppPlan, FileSyncPlan, ServicePlan } from "./app-plan.ts";
import { ConfigLintResult, ConfigLintViolation } from "./config-lint.ts";
import { GlobalConfig } from "./config.ts";
import { DeprecationNotice, DeprecationNoticeJsonShape, DeprecationUse } from "./deprecation.ts";
import {
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionInfo,
  FileSyncSessionSpec,
} from "./file-sync-engine.ts";
import { getJsonSchemaWithDeprecations } from "./json-schema-deprecations.ts";
import { LandofileShape } from "./landofile.ts";
import { AppRef, ProviderCapabilities } from "./networking.ts";
import { PluginTrustState } from "./plugin-trust.ts";
import { EmbeddingPluginPolicy, GlobalServiceContribution, PluginManifest } from "./plugin.ts";
import { AppId, BootstrapLevel, HostPlatform, ProviderId, ServiceName } from "./primitives.ts";
import { ServiceInfo } from "./service-info.ts";

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
  PublicTranscript,
  BootstrapLevel,
  AppRef,
  AppPlan,
  ServicePlan,
  ProviderCapabilities,
  LandofileShape,
  GlobalConfig,
  ConfigLintViolation,
  ConfigLintResult,
  AppId,
  ServiceName,
  ProviderId,
  HostPlatform,
  ServiceInfo,
  EmbeddingPluginPolicy,
  PluginManifest,
  PluginTrustState,
  GlobalServiceContribution,
  FileSyncEngineCapabilities,
  FileSyncSessionSpec,
  FileSyncSessionInfo,
  FileSyncEventChunk,
  FileSyncPlan,
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

export const getJsonSchema = (schemaName: JsonSchemaName) => {
  switch (schemaName) {
    case "BootstrapLevel":
      return getJsonSchemaWithDeprecations(BootstrapLevel);
    case "DeprecationNotice":
      return getJsonSchemaWithDeprecations(DeprecationNoticeJsonShape);
    case "DeprecationUse":
      return getJsonSchemaWithDeprecations(DeprecationUse);
    case "GuideFrontmatter":
      return getJsonSchemaWithDeprecations(GuideFrontmatter);
    case "GuideProps":
      return getJsonSchemaWithDeprecations(GuideProps);
    case "ScenarioProps":
      return getJsonSchemaWithDeprecations(ScenarioProps);
    case "StepProps":
      return getJsonSchemaWithDeprecations(StepProps);
    case "RunProps":
      return getJsonSchemaWithDeprecations(RunProps);
    case "VerifyProps":
      return getJsonSchemaWithDeprecations(VerifyProps);
    case "CleanupProps":
      return getJsonSchemaWithDeprecations(CleanupProps);
    case "VariableProps":
      return getJsonSchemaWithDeprecations(VariableProps);
    case "HiddenProps":
      return getJsonSchemaWithDeprecations(HiddenProps);
    case "InspectProps":
      return getJsonSchemaWithDeprecations(InspectProps);
    case "TabsProps":
      return getJsonSchemaWithDeprecations(TabsProps);
    case "TabProps":
      return getJsonSchemaWithDeprecations(TabProps);
    case "InlineProps":
      return getJsonSchemaWithDeprecations(InlineProps);
    case "SkipProps":
      return getJsonSchemaWithDeprecations(SkipProps);
    case "UseFixtureProps":
      return getJsonSchemaWithDeprecations(UseFixtureProps);
    case "MatcherSchema":
      return getJsonSchemaWithDeprecations(MatcherSchema);
    case "Transcript":
      return getJsonSchemaWithDeprecations(Transcript);
    case "PublicTranscript":
      return getJsonSchemaWithDeprecations(PublicTranscript);
    case "AppRef":
      return getJsonSchemaWithDeprecations(AppRef);
    case "AppPlan":
      return getJsonSchemaWithDeprecations(AppPlan);
    case "ServicePlan":
      return getJsonSchemaWithDeprecations(ServicePlan);
    case "ProviderCapabilities":
      return getJsonSchemaWithDeprecations(ProviderCapabilities);
    case "LandofileShape":
      return landofileJsonSchema();
    case "GlobalConfig":
      return getJsonSchemaWithDeprecations(GlobalConfig);
    case "ConfigLintViolation":
      return getJsonSchemaWithDeprecations(ConfigLintViolation);
    case "ConfigLintResult":
      return getJsonSchemaWithDeprecations(ConfigLintResult);
    case "AppId":
      return getJsonSchemaWithDeprecations(AppId);
    case "ServiceName":
      return getJsonSchemaWithDeprecations(ServiceName);
    case "ProviderId":
      return getJsonSchemaWithDeprecations(ProviderId);
    case "HostPlatform":
      return getJsonSchemaWithDeprecations(HostPlatform);
    case "ServiceInfo":
      return getJsonSchemaWithDeprecations(ServiceInfo);
    case "EmbeddingPluginPolicy":
      return getJsonSchemaWithDeprecations(EmbeddingPluginPolicy);
    case "PluginManifest":
      return getJsonSchemaWithDeprecations(PluginManifest);
    case "PluginTrustState":
      return getJsonSchemaWithDeprecations(PluginTrustState);
    case "GlobalServiceContribution":
      return getJsonSchemaWithDeprecations(GlobalServiceContribution);
    case "FileSyncEngineCapabilities":
      return getJsonSchemaWithDeprecations(FileSyncEngineCapabilities);
    case "FileSyncSessionSpec":
      return getJsonSchemaWithDeprecations(FileSyncSessionSpec);
    case "FileSyncSessionInfo":
      return getJsonSchemaWithDeprecations(FileSyncSessionInfo);
    case "FileSyncEventChunk":
      return getJsonSchemaWithDeprecations(FileSyncEventChunk);
    case "FileSyncPlan":
      return getJsonSchemaWithDeprecations(FileSyncPlan);
  }
};
