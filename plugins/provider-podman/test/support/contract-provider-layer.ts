import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBuiltContainerHelperForTest,
  supervisedExecFixtureOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { layer as providerLayer } from "@lando/provider-podman";
import { AbsolutePath } from "@lando/sdk/schema";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

export const makeProviderLayer = (options: NonNullable<Parameters<typeof providerLayer>[0]> = {}) =>
  providerLayer({
    resolveContainerHelper: resolveBuiltContainerHelperForTest,
    ...options,
    ...supervisedExecFixtureOptions(options.podmanApi),
    appliedPlanState:
      options.appliedPlanState ??
      makePluginStateStore(
        makeTestStateStore().service,
        AbsolutePath.make(join(tmpdir(), `podman-contract-${crypto.randomUUID()}`)),
        ownerOnlyFileAccess,
      ),
  });
