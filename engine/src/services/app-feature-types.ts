import type { AppFeatureError } from "@lando/sdk/errors";
import type { ProviderCapabilities, ServiceConfig } from "@lando/sdk/schema";
import type { AppFeatureDefinition, AppFeatureServiceView } from "@lando/sdk/services";
import type { Effect } from "effect";
import type { DraftServicePlan } from "./draft.ts";

export interface AppFeatureServiceDraft extends DraftServicePlan {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly base: "l337" | "lando";
  readonly framework?: string | undefined;
  readonly featureIds: readonly string[];
  readonly normalizedConfig: ServiceConfig;
}
export interface ComposeAppFeature {
  readonly id: string;
  readonly definition: AppFeatureDefinition;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly pluginId?: string | undefined;
}
export type FromConfigSelectorResolver = (
  expression: string,
  context: {
    readonly appName?: string | undefined;
    readonly appRoot: string;
    readonly services: readonly AppFeatureServiceView[];
  },
) => Effect.Effect<readonly string[], AppFeatureError>;
export interface AppFeatureSelectionInput {
  readonly appName?: string | undefined;
  readonly appRoot: string;
  readonly services: readonly AppFeatureServiceView[];
  readonly features: readonly ComposeAppFeature[];
  readonly resolveFromConfig?: FromConfigSelectorResolver | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}
export interface ComposeAppFeaturesInput extends AppFeatureSelectionInput {
  readonly services: readonly AppFeatureServiceDraft[];
}
export type AppFeatureApplicationInput = Pick<ComposeAppFeaturesInput, "appName" | "appRoot" | "services">;
export interface ActivatedAppFeature {
  readonly id: string;
  readonly pluginId?: string | undefined;
  readonly priority: number;
  readonly selectedServices: readonly string[];
  readonly triggeredByServices: readonly string[];
}
export interface AppFeatureRequires {
  readonly providerCapabilities: readonly (keyof ProviderCapabilities)[];
  readonly globalServices: readonly string[];
}
export interface ComposeAppFeaturesResult {
  readonly activatedFeatures: readonly ActivatedAppFeature[];
  readonly requires: AppFeatureRequires;
}
export interface OrderedAppFeature extends ComposeAppFeature {
  readonly index: number;
}
export interface ActivationPlan {
  readonly feature: OrderedAppFeature;
  readonly triggeredByServices: readonly string[];
  readonly selectedServices: readonly string[];
}
export const viewOf = (view: AppFeatureServiceView): AppFeatureServiceView => ({
  serviceName: view.serviceName,
  serviceType: view.serviceType,
  base: view.base,
  framework: view.framework,
  primary: view.primary,
  featureIds: view.featureIds,
  normalizedConfig: view.normalizedConfig,
  connection: view.connection,
});
