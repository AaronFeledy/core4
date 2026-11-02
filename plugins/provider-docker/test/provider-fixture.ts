import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeRuntimeProvider as factory } from "@lando/provider-docker";
import { AbsolutePath } from "@lando/sdk/schema";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const state = () =>
  makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(join(tmpdir(), `docker-fixture-${crypto.randomUUID()}`)),
    ownerOnlyFileAccess,
  );
export const makeRuntimeProvider = (options: NonNullable<Parameters<typeof factory>[0]> = {}) =>
  factory({ ...options, appliedPlanState: options.appliedPlanState ?? state() });
