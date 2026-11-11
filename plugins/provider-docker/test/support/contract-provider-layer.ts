import { tmpdir } from "node:os";
import path from "node:path";
import {
  fixtureHelperOptionsFor,
  resolveBuiltContainerHelperForTest,
  supervisedExecFixtureOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { layer as providerLayer } from "@lando/provider-docker";
import { AbsolutePath } from "@lando/sdk/schema";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

export const testPluginState = () =>
  makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(path.join(tmpdir(), `docker-contract-${crypto.randomUUID()}`)),
    ownerOnlyFileAccess,
  );
export const makeProviderLayer = (options: NonNullable<Parameters<typeof providerLayer>[0]> = {}) =>
  providerLayer({
    ...fixtureHelperOptionsFor(options.dockerApi),
    resolveContainerHelper: resolveBuiltContainerHelperForTest,
    ...options,
    ...supervisedExecFixtureOptions(options.dockerApi),
    appliedPlanState: options.appliedPlanState ?? testPluginState(),
  });
