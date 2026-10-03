#!/usr/bin/env bun
/**
 * Regenerate `core/src/runtime/generated/layers/*` from the bootstrap layer graph.
 *
 * Inputs:
 *   - `@lando/sdk/schema` BootstrapLevel / BOOTSTRAP_RANK
 *   - `core/src/runtime/bootstrap-layer-support.ts` runtime-varying inputs
 *   - The core runtime service membership graph
 *
 * Output:
 *   - `core/src/runtime/generated/layers/*.ts` — one generated layer factory per bootstrap level.
 *
 * Drift gate: `bun run codegen` re-runs this generator and
 * `git diff --exit-code` fails if the output drifts.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { BOOTSTRAP_RANK } from "@lando/sdk/schema";

import { writeFormattedOutput } from "./_codegen-output.ts";
import { renderCommands, renderIndex, renderMinimal, renderProvider } from "./bootstrap-layer-renderers.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = resolve(REPO_ROOT, "core/src/runtime/generated/layers");

const HEADER = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-bootstrap-layers.ts\`.
 *
 * Source of truth: \`scripts/build-bootstrap-layers.ts\`, \`BootstrapLevel\`, and the
 * core runtime service membership graph.
 *
 * Bootstrap layer composition is emitted ahead of time so hand-authored
 * runtime factories do not rebuild the Effect Layer graph outside this
 * generated output.
 */
`;

const levelOrder = Object.keys(BOOTSTRAP_RANK).sort(
  (left, right) =>
    BOOTSTRAP_RANK[left as keyof typeof BOOTSTRAP_RANK] -
    BOOTSTRAP_RANK[right as keyof typeof BOOTSTRAP_RANK],
);

const renderPlugins = (): string =>
  [
    'import { Context, Layer } from "effect";',
    "",
    'import { EventService } from "@lando/sdk/services";',
    'import { bundledPluginModules } from "@lando/engine/composition";',
    'import * as DeprecationPluginRegistry from "@lando/engine/deprecation/plugin-registry";',
    'import * as ConfigTranslatorRegistryLayer from "@lando/engine/plugins/config-translator-registry";',
    'import * as PluginContributionGraphLayer from "@lando/engine/plugins/contribution-graph";',
    'import * as PluginRegistryLayer from "@lando/engine/plugins/registry";',
    'import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";',
    'import * as BuiltInCommandCatalogLayer from "../../../cli/built-in-command-catalog-live.ts";',
    'import { makeMinimalBootstrapLayer } from "./minimal.ts";',
    "",
    "export const makePluginsBootstrapBaseLayer = (inputs: BootstrapLayerInputs) => {",
    "  const minimalRuntimeGraph = makeMinimalBootstrapLayer(inputs);",
    "  const minimalRuntimeLayer = Layer.suspend(() => minimalRuntimeGraph);",
    "  const contributionGraphLayer = PluginContributionGraphLayer.PluginContributionGraph.layer({",
    "    layers: inputs.pluginLayers,",
    "    manifests: inputs.pluginManifests,",
    "    discovery: inputs.pluginDiscovery,",
    "    externalImports: inputs.externalImports,",
    "    cwd: inputs.cwd,",
    "  }, bundledPluginModules()).pipe(Layer.provide(minimalRuntimeLayer));",
    "  const pluginRegistryLayer = PluginRegistryLayer.layerWith(inputs.pluginDiscovery, bundledPluginModules()).pipe(",
    "    Layer.provide(Layer.merge(minimalRuntimeLayer, contributionGraphLayer)),",
    "  );",
    "  const deprecationRegistryLayer = DeprecationPluginRegistry.layer.pipe(",
    "    Layer.provide(Layer.mergeAll(minimalRuntimeLayer, pluginRegistryLayer)),",
    "  );",
    "  const configTranslatorRegistryLayer = ConfigTranslatorRegistryLayer.layerWith(bundledPluginModules()).pipe(",
    "    Layer.provide(Layer.merge(minimalRuntimeLayer, contributionGraphLayer)),",
    "  );",
    "  return Layer.mergeAll(minimalRuntimeLayer, contributionGraphLayer, pluginRegistryLayer, deprecationRegistryLayer, configTranslatorRegistryLayer, BuiltInCommandCatalogLayer.layer).pipe(",
    '    Layer.tap((context) => inputs.lifecycle.complete("plugins", Context.get(context, EventService))),',
    "  );",
    "};",
    "",
  ].join("\n");

const renderTooling = (): string =>
  [
    'import { Context, Layer } from "effect";',
    "",
    'import { EventService } from "@lando/sdk/services";',
    'import { bundledPluginModules } from "@lando/engine/composition";',
    'import * as SubscriberRuntimeLayer from "@lando/engine/lifecycle/subscribers";',
    'import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";',
    'import { BUILT_IN_COMMAND_IDS } from "../../../cli/generated/command-ids.ts";',
    'import { makeCommandsBootstrapBaseLayer } from "./commands.ts";',
    "",
    "export const makeToolingBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const toolingBase = makeCommandsBootstrapBaseLayer(inputs);",
    "  const subscriberRuntimeLayer = SubscriberRuntimeLayer.layerWithPrivateFileAccess(bundledPluginModules(), BUILT_IN_COMMAND_IDS).pipe(Layer.provide(toolingBase));",
    "  return Layer.merge(toolingBase, subscriberRuntimeLayer).pipe(",
    '    Layer.tap((context) => inputs.lifecycle.complete("tooling", Context.get(context, EventService))),',
    "  );",
    "};",
    "",
  ].join("\n");

const renderGlobal = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";',
    'import * as AppPlannerLayer from "@lando/engine/services/planner";',
    'import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";',
    'import { makeProviderBootstrapLayer } from "./provider.ts";',
    "",
    "export const makeGlobalBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerBase = makeProviderBootstrapLayer(inputs);",
    "  return Layer.mergeAll(",
    "    providerBase,",
    "    AppPlannerLayer.layer.pipe(Layer.provide(providerBase)),",
    "    Layer.suspend(() => BuildOrchestratorLayer.layer.pipe(Layer.provide(providerBase))),",
    "  );",
    "};",
    "",
  ].join("\n");

const renderScratch = (): string =>
  [
    'import { Effect, Layer } from "effect";',
    "",
    'import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";',
    'import { bundledPluginModules } from "@lando/engine/composition";',
    'import * as GlobalAppRuntimeLayer from "@lando/engine/global-app/runtime";',
    'import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";',
    'import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";',
    'import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";',
    'import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";',
    'import * as AppPlannerLayer from "@lando/engine/services/planner";',
    'import * as RouterServiceRegistryLayer from "@lando/engine/subsystems/proxy/registry";',
    'import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";',
    'import * as ScratchInitAppPortLayer from "../../scratch-init-port.ts";',
    'import { makeProviderBootstrapLayer } from "./provider.ts";',
    "",
    "export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerBase = makeProviderBootstrapLayer(inputs);",
    "  const plannerLayer = AppPlannerLayer.layer.pipe(Layer.provide(providerBase));",
    "  const buildOrchestratorLayer = BuildOrchestratorLayer.layer.pipe(Layer.provide(providerBase));",
    "  const scratchBase = Layer.mergeAll(providerBase, plannerLayer, buildOrchestratorLayer);",
    "  const routerRegistryLayer = Layer.fromBuildMemo((memoMap, scope) => Layer.buildWithMemoMap(RouterServiceRegistryLayer.RouterServiceRegistry.layerWith(bundledPluginModules()).pipe(",
    "    Layer.provide(scratchBase),",
    "  ), memoMap, scope).pipe(",
    "    Effect.mapError((cause) =>",
    '      new LandoRuntimeBootstrapError({ message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.", stage: "provider", cause }),',
    "    ),",
    "  ));",
    "  const globalAppRuntimeLayer = GlobalAppRuntimeLayer.layer.pipe(Layer.provide(scratchBase));",
    "  const routerServiceLayer = Layer.fromBuildMemo((memoMap, scope) => Layer.buildWithMemoMap(RouterServiceRegistryLayer.layerSelected.pipe(",
    "    Layer.provide(Layer.mergeAll(scratchBase, globalAppRuntimeLayer, routerRegistryLayer)),",
    "  ), memoMap, scope).pipe(",
    "    Effect.mapError((cause) =>",
    '      new LandoRuntimeBootstrapError({ message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.", stage: "provider", cause }),',
    "    ),",
    "  ));",
    "  const scratchDeps = Layer.mergeAll(",
    "    globalAppRuntimeLayer,",
    "    routerRegistryLayer,",
    "    routerServiceLayer,",
    "    ScratchRegistryLayer.ScratchRegistry.layerWithPrivateFileAccess.pipe(Layer.provide(providerBase)),",
    "    ScratchResourceScannerLayer.ScratchResourceScanner.layer.pipe(Layer.provide(providerBase)),",
    "    ScratchInitAppPortLayer.layer,",
    "  ).pipe(Layer.provideMerge(scratchBase));",
    "  return Layer.mergeAll(",
    "    globalAppRuntimeLayer,",
    "    routerRegistryLayer,",
    "    routerServiceLayer,",
    "    ScratchAppServiceLayer.layer.pipe(Layer.provide(scratchDeps)),",
    "  ).pipe(Layer.provideMerge(scratchDeps));",
    "};",
    "",
  ].join("\n");

const renderApp = (): string =>
  [
    'import { Context, Effect, Layer } from "effect";',
    "",
    'import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";',
    'import { EventService } from "@lando/sdk/services";',
    'import { bundledPluginModules } from "@lando/engine/composition";',
    'import * as SubscriberRuntimeLayer from "@lando/engine/lifecycle/subscribers";',
    'import * as GlobalAppRuntimeLayer from "@lando/engine/global-app/runtime";',
    'import * as BundledFileSyncEngine from "@lando/engine/plugins/file-sync-from-modules";',
    'import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";',
    'import * as AppPlannerLayer from "@lando/engine/services/planner";',
    'import * as BunShellRunner from "@lando/engine/services/shell-runner";',
    'import * as ProviderExecToolingEngine from "@lando/engine/services/tooling-engine";',
    'import * as RouterServiceRegistryLayer from "@lando/engine/subsystems/proxy/registry";',
    'import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";',
    'import { BUILT_IN_COMMAND_IDS } from "../../../cli/generated/command-ids.ts";',
    'import * as EventCommandExecutorLayer from "../../../cli/event-command-executor.ts";',
    'import { makeProcessShellReplIO } from "../../../cli/host-shell-terminal.ts";',
    'import { makeProviderBootstrapBaseLayer } from "./provider.ts";',
    "",
    "export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerGraph = makeProviderBootstrapBaseLayer(inputs);",
    "  const providerBase = Layer.suspend(() => providerGraph);",
    "  const buildOrchestratorLayer = Layer.suspend(() => BuildOrchestratorLayer.layer.pipe(Layer.provide(providerBase)));",
    "  const appBase = Layer.mergeAll(",
    "    providerBase,",
    "    buildOrchestratorLayer,",
    "    AppPlannerLayer.layer.pipe(Layer.provide(providerBase)),",
    "    ProviderExecToolingEngine.layer,",
    "    BunShellRunner.layerWithPrivateFileAccess(makeProcessShellReplIO).pipe(Layer.provide(providerBase)),",
    "    BundledFileSyncEngine.layerWith(bundledPluginModules()).pipe(Layer.provide(providerBase)),",
    "  );",
    "  const routerRegistryLayer = Layer.fromBuildMemo((memoMap, scope) => Layer.buildWithMemoMap(RouterServiceRegistryLayer.RouterServiceRegistry.layerWith(bundledPluginModules()).pipe(",
    "    Layer.provide(appBase),",
    "  ), memoMap, scope).pipe(",
    "    Effect.mapError((cause) =>",
    '      new LandoRuntimeBootstrapError({ message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.", stage: "app", cause }),',
    "    ),",
    "  ));",
    "  const globalAppRuntimeLayer = GlobalAppRuntimeLayer.layer.pipe(Layer.provide(appBase));",
    "  const routerServiceLayer = Layer.fromBuildMemo((memoMap, scope) => Layer.buildWithMemoMap(RouterServiceRegistryLayer.layerSelected.pipe(",
    "    Layer.provide(Layer.mergeAll(appBase, globalAppRuntimeLayer, routerRegistryLayer)),",
    "  ), memoMap, scope).pipe(",
    "    Effect.mapError((cause) =>",
    '      new LandoRuntimeBootstrapError({ message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.", stage: "app", cause }),',
    "    ),",
    "  ));",
    "  const fullAppBase = Layer.mergeAll(appBase, globalAppRuntimeLayer, routerRegistryLayer, routerServiceLayer);",
    "  const eventCommandExecutorLayer = EventCommandExecutorLayer.layer.pipe(Layer.provide(fullAppBase));",
    "  const runtimeAppBase = Layer.merge(fullAppBase, eventCommandExecutorLayer);",
    "  const subscriberRuntimeLayer = SubscriberRuntimeLayer.layerWithPrivateFileAccess(bundledPluginModules(), BUILT_IN_COMMAND_IDS).pipe(Layer.provide(runtimeAppBase));",
    "  return Layer.merge(runtimeAppBase, subscriberRuntimeLayer).pipe(",
    '    Layer.tap((context) => inputs.lifecycle.complete("app", Context.get(context, EventService))),',
    "  );",
    "};",
    "",
  ].join("\n");

const renderNone = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";',
    'import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";',
    "",
    "export const makeNoneBootstrapLayer = (inputs: BootstrapLayerInputs) =>",
    "  Layer.succeed(RuntimeLayerFactory, inputs.runtimeLayerFactory);",
    "",
  ].join("\n");

const renderers: Record<string, () => string> = {
  none: renderNone,
  minimal: renderMinimal,
  plugins: renderPlugins,
  commands: renderCommands,
  tooling: renderTooling,
  provider: renderProvider,
  global: renderGlobal,
  scratch: renderScratch,
  app: renderApp,
  index: renderIndex,
};

const main = async (): Promise<void> => {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const files = [...levelOrder, "index"];
  for (const name of files) {
    const render = renderers[name];
    if (render === undefined) throw new Error(`No bootstrap layer renderer for ${name}`);
    const output = resolve(OUTPUT_DIR, `${name}.ts`);
    await writeFormattedOutput(output, `${HEADER}\n${render()}`);
  }

  const expectedFiles = new Set(files.map((file) => `${file}.ts`));
  for (const file of await readdir(OUTPUT_DIR).catch(() => [])) {
    if (file.endsWith(".ts") && !expectedFiles.has(file)) await rm(resolve(OUTPUT_DIR, file));
  }

  console.log(`[build-bootstrap-layers] wrote ${OUTPUT_DIR} (${files.length} files)`);
};

await main();
