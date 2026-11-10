import {
  resolveBuiltContainerHelperForTest,
  supervisedExecFixtureOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import { makeProviderLayer as providerLayer } from "../provider-fixture.ts";

export const makeProviderLayer = (options: NonNullable<Parameters<typeof providerLayer>[0]>) =>
  providerLayer({
    resolveContainerHelper: resolveBuiltContainerHelperForTest,
    ...options,
    ...supervisedExecFixtureOptions(options.podmanApi),
  });
