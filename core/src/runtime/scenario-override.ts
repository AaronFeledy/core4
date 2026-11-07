import { AsyncLocalStorage } from "node:async_hooks";
import type { LandoEvent, RouterService, RuntimeProviderRegistry, UrlScanner } from "@lando/sdk/services";
import type { Layer } from "effect";

/**
 * Test-host substitution for one in-process CLI invocation: the provider registry every
 * runtime consumer is built with, in-memory host services, and an observer for every event the
 * invocation publishes.
 */
export interface ScenarioRuntimeOverride {
  readonly providerRegistry: Layer.Layer<RuntimeProviderRegistry>;
  /** In-memory routing and URL scanning, merged over the runtime like embedding plugin layers. */
  readonly hostServices: Layer.Layer<RouterService | UrlScanner>;
  /** Receives each published event after redaction, in the publishing fiber. */
  readonly observeEvent: (event: LandoEvent) => void;
}

const scenarioRuntimeOverrideStorage = new AsyncLocalStorage<ScenarioRuntimeOverride>();

export const getScenarioRuntimeOverride = (): ScenarioRuntimeOverride | undefined =>
  scenarioRuntimeOverrideStorage.getStore();

export const withScenarioRuntimeOverride = <A>(
  override: ScenarioRuntimeOverride,
  thunk: () => Promise<A>,
): Promise<A> => scenarioRuntimeOverrideStorage.run(override, thunk);
