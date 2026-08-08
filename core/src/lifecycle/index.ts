/**
 * `@lando/core/events` — re-exported from `dist/lifecycle/index.js`
 * (this is the entry point that backs the `./events` export).
 *
 * Re-exports:
 *   - `EventService` tag (from `./events.ts`).
 *   - Every event payload schema (from `@lando/sdk/events` via `./schema.ts`).
 *   - Subscriber priority bands and types (from `@lando/sdk/events`).
 */

import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { PluginManifest } from "@lando/sdk/schema";
import type { RegisteredCommand } from "@lando/sdk/services";

import {
  canonicalSubscriberCommandIds as canonicalEngineSubscriberCommandIds,
  makeSubscriberRuntimeLive as makeEngineSubscriberRuntimeLive,
} from "@lando/engine/lifecycle/subscribers";
import { BUILT_IN_COMMAND_IDS } from "../cli/generated/command-ids";
import { BUNDLED_PLUGIN_MODULES } from "../plugins/generated/bundled";

export * from "@lando/engine/lifecycle/events";
export * from "@lando/engine/lifecycle/schema";
export * from "@lando/engine/lifecycle/subscribers";

export const canonicalSubscriberCommandIds = (
  manifests: ReadonlyArray<PluginManifest>,
  commands: ReadonlyArray<RegisteredCommand> = [],
  builtIns: ReadonlyArray<string> = BUILT_IN_COMMAND_IDS,
): ReadonlyArray<string> => canonicalEngineSubscriberCommandIds(manifests, commands, builtIns);

export const makeSubscriberRuntimeLive = (
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
  builtIns: ReadonlyArray<string> = BUILT_IN_COMMAND_IDS,
) => makeEngineSubscriberRuntimeLive(modules, builtIns);
