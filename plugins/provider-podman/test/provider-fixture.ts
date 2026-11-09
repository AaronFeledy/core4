import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureHelperOptionsFor } from "@lando/container-runtime/testing/exec-supervision";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeRuntimeProvider as factory, layer } from "@lando/provider-podman";
import { AbsolutePath } from "@lando/sdk/schema";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const state = () =>
  makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(join(tmpdir(), `podman-fixture-${crypto.randomUUID()}`)),
    ownerOnlyFileAccess,
  );
export const makeRuntimeProvider = (options: NonNullable<Parameters<typeof factory>[0]> = {}) =>
  factory({
    ...fixtureHelperOptionsFor(options.podmanApi),
    ...options,
    appliedPlanState: options.appliedPlanState ?? state(),
  });
export const makeProviderLayer = (options: NonNullable<Parameters<typeof layer>[0]> = {}) =>
  layer({
    ...fixtureHelperOptionsFor(options.podmanApi),
    ...options,
    appliedPlanState: options.appliedPlanState ?? state(),
  });
