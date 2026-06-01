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
import { DeprecationNotice, GuideFrontmatter } from "../docs/guide-frontmatter.ts";
import { Transcript } from "../docs/transcript.ts";
import { AppPlan, FileSyncPlan, ServicePlan } from "./app-plan.ts";
import { GlobalConfig } from "./config.ts";
import {
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionInfo,
  FileSyncSessionSpec,
} from "./file-sync-engine.ts";
import { LandofileShape } from "./landofile.ts";
import { AppRef, ProviderCapabilities } from "./networking.ts";
import { GlobalServiceContribution, PluginManifest } from "./plugin.ts";
import { AppId, BootstrapLevel, HostPlatform, ProviderId, ServiceName } from "./primitives.ts";
import { ServiceInfo } from "./service-info.ts";

// JSON Schema accessors.

const JSON_SCHEMA_REGISTRY = {
  DeprecationNotice,
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
  BootstrapLevel,
  AppRef,
  AppPlan,
  ServicePlan,
  ProviderCapabilities,
  LandofileShape,
  GlobalConfig,
  AppId,
  ServiceName,
  ProviderId,
  HostPlatform,
  ServiceInfo,
  PluginManifest,
  GlobalServiceContribution,
  FileSyncEngineCapabilities,
  FileSyncSessionSpec,
  FileSyncSessionInfo,
  FileSyncEventChunk,
  FileSyncPlan,
} as const;

export type JsonSchemaName = keyof typeof JSON_SCHEMA_REGISTRY;

export const getJsonSchema = (schemaName: JsonSchemaName) => {
  switch (schemaName) {
    case "BootstrapLevel":
      return JSONSchema.make(BootstrapLevel);
    case "DeprecationNotice":
      return JSONSchema.make(DeprecationNotice);
    case "GuideFrontmatter":
      return JSONSchema.make(GuideFrontmatter);
    case "GuideProps":
      return JSONSchema.make(GuideProps);
    case "ScenarioProps":
      return JSONSchema.make(ScenarioProps);
    case "StepProps":
      return JSONSchema.make(StepProps);
    case "RunProps":
      return JSONSchema.make(RunProps);
    case "VerifyProps":
      return JSONSchema.make(VerifyProps);
    case "CleanupProps":
      return JSONSchema.make(CleanupProps);
    case "VariableProps":
      return JSONSchema.make(VariableProps);
    case "HiddenProps":
      return JSONSchema.make(HiddenProps);
    case "InspectProps":
      return JSONSchema.make(InspectProps);
    case "TabsProps":
      return JSONSchema.make(TabsProps);
    case "TabProps":
      return JSONSchema.make(TabProps);
    case "InlineProps":
      return JSONSchema.make(InlineProps);
    case "SkipProps":
      return JSONSchema.make(SkipProps);
    case "UseFixtureProps":
      return JSONSchema.make(UseFixtureProps);
    case "MatcherSchema":
      return JSONSchema.make(MatcherSchema);
    case "Transcript":
      return JSONSchema.make(Transcript);
    case "AppRef":
      return JSONSchema.make(AppRef);
    case "AppPlan":
      return JSONSchema.make(AppPlan);
    case "ServicePlan":
      return JSONSchema.make(ServicePlan);
    case "ProviderCapabilities":
      return JSONSchema.make(ProviderCapabilities);
    case "LandofileShape":
      return JSONSchema.make(LandofileShape);
    case "GlobalConfig":
      return JSONSchema.make(GlobalConfig);
    case "AppId":
      return JSONSchema.make(AppId);
    case "ServiceName":
      return JSONSchema.make(ServiceName);
    case "ProviderId":
      return JSONSchema.make(ProviderId);
    case "HostPlatform":
      return JSONSchema.make(HostPlatform);
    case "ServiceInfo":
      return JSONSchema.make(ServiceInfo);
    case "PluginManifest":
      return JSONSchema.make(PluginManifest);
    case "GlobalServiceContribution":
      return JSONSchema.make(GlobalServiceContribution);
    case "FileSyncEngineCapabilities":
      return JSONSchema.make(FileSyncEngineCapabilities);
    case "FileSyncSessionSpec":
      return JSONSchema.make(FileSyncSessionSpec);
    case "FileSyncSessionInfo":
      return JSONSchema.make(FileSyncSessionInfo);
    case "FileSyncEventChunk":
      return JSONSchema.make(FileSyncEventChunk);
    case "FileSyncPlan":
      return JSONSchema.make(FileSyncPlan);
  }
};
