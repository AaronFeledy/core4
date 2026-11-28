import { tmpdir } from "node:os";
import path from "node:path";
import {
  fixtureHelperOptionsFor,
  resolveBuiltContainerHelperForTest,
  supervisedExecFixtureOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore, withTestVolumeLocks } from "@lando/engine/testing/state-store";
import { layer as providerLayer } from "@lando/provider-docker";
import { AbsolutePath } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

export const testPluginState = () =>
  makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(path.join(tmpdir(), `docker-contract-${crypto.randomUUID()}`)),
    ownerOnlyFileAccess,
  );
export const makeProviderLayer = (options: NonNullable<Parameters<typeof providerLayer>[0]> = {}) =>
  Layer.effect(RuntimeProvider, Effect.map(RuntimeProvider, withTestVolumeLocks)).pipe(
    Layer.provide(
      providerLayer({
        ...fixtureHelperOptionsFor(options.dockerApi),
        resolveContainerHelper: resolveBuiltContainerHelperForTest,
        ...options,
        ...supervisedExecFixtureOptions(options.dockerApi),
        // Isolate from the host Docker CLI context unless a test supplies env.
        env: options.env ?? {},
        appliedPlanState: options.appliedPlanState ?? testPluginState(),
      }),
    ),
  );
