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
import { basename, resolve } from "node:path";

import { BOOTSTRAP_RANK } from "@lando/sdk/schema";

import { writeFormattedOutput } from "./_codegen-output.ts";
import { renderAlias, renderMinimal, renderProvider } from "./bootstrap-layer-renderers.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = resolve(REPO_ROOT, "core/src/runtime/generated/layers");

const HEADER = (command = "bun run scripts/build-bootstrap-layers.ts") => `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`${command}\`.
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
    'import { Layer } from "effect";',
    "",
    'import { DeprecationPluginRegistryLive } from "../../../deprecation/plugin-registry.ts";',
    'import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";',
    'import { makePluginRegistryLive } from "../../../plugins/registry.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makeMinimalBootstrapLayer } from "./minimal.ts";',
    "",
    "export const makePluginsBootstrapBaseLayer = (inputs: BootstrapLayerInputs) => {",
    "  const minimalRuntimeLive = makeMinimalBootstrapLayer(inputs);",
    "  const pluginRegistryLive = makePluginRegistryLive(inputs.pluginDiscovery).pipe(",
    "    Layer.provide(minimalRuntimeLive),",
    "  );",
    "  const deprecationRegistryLive = DeprecationPluginRegistryLive.pipe(",
    "    Layer.provide(Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive)),",
    "  );",
    "  return Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive, deprecationRegistryLive);",
    "};",
    "",
    "export const makePluginsBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const pluginsBase = makePluginsBootstrapBaseLayer(inputs);",
    "  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(pluginsBase));",
    "  return Layer.merge(pluginsBase, subscriberRuntimeLive);",
    "};",
    "",
  ].join("\n");

const renderTooling = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import { LandofileServiceLive } from "../../../landofile/service.ts";',
    'import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";',
    'import { CommandRegistryLive } from "../../../services/command-registry.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makePluginsBootstrapBaseLayer } from "./plugins.ts";',
    "",
    "export const makeToolingBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const pluginsRuntimeLive = makePluginsBootstrapBaseLayer(inputs);",
    "  const commandRegistryLive = CommandRegistryLive.pipe(",
    "    Layer.provide(Layer.mergeAll(LandofileServiceLive, pluginsRuntimeLive)),",
    "  );",
    "  const toolingBase = Layer.mergeAll(pluginsRuntimeLive, LandofileServiceLive, commandRegistryLive);",
    "  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(toolingBase));",
    "  return Layer.merge(toolingBase, subscriberRuntimeLive);",
    "};",
    "",
  ].join("\n");

const renderGlobal = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";',
    'import { AppPlannerLive } from "../../../services/planner.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makeProviderBootstrapLayer } from "./provider.ts";',
    "",
    "export const makeGlobalBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerBase = makeProviderBootstrapLayer(inputs);",
    "  return Layer.mergeAll(",
    "    providerBase,",
    "    AppPlannerLive.pipe(Layer.provide(providerBase)),",
    "    Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase))),",
    "  );",
    "};",
    "",
  ].join("\n");

const renderScratch = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import { LandofileServiceLive } from "../../../landofile/service.ts";',
    'import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";',
    'import { ScratchRegistryLive } from "../../../scratch-app/registry.ts";',
    'import { ScratchResourceScannerLive } from "../../../scratch-app/scanner.ts";',
    'import { ScratchAppServiceLive } from "../../../scratch-app/service.ts";',
    'import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";',
    'import { AppPlannerLive } from "../../../services/planner.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makeProviderBootstrapLayer } from "./provider.ts";',
    "",
    "export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerBase = makeProviderBootstrapLayer(inputs);",
    "  const plannerLive = AppPlannerLive.pipe(Layer.provide(providerBase));",
    "  const buildOrchestratorLive = BuildOrchestratorLive.pipe(Layer.provide(providerBase));",
    "  const scratchDeps = Layer.mergeAll(",
    "    providerBase,",
    "    LandofileServiceLive,",
    "    plannerLive,",
    "    buildOrchestratorLive,",
    "    ScratchRegistryLive,",
    "    ScratchResourceScannerLive,",
    "  );",
    "  return Layer.mergeAll(",
    "    providerBase,",
    "    LandofileServiceLive,",
    "    plannerLive,",
    "    buildOrchestratorLive,",
    "    ScratchRegistryLive,",
    "    ScratchResourceScannerLive,",
    "    ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),",
    "  );",
    "};",
    "",
  ].join("\n");

const renderApp = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";',
    'import { LandofileServiceLive } from "../../../landofile/service.ts";',
    'import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";',
    'import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";',
    'import { CommandRegistryLive } from "../../../services/command-registry.ts";',
    'import { AppPlannerLive } from "../../../services/planner.ts";',
    'import { ShellRunnerLive } from "../../../services/shell-runner.ts";',
    'import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makeProviderBootstrapBaseLayer } from "./provider.ts";',
    "",
    "export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerBase = makeProviderBootstrapBaseLayer(inputs);",
    "  const buildOrchestratorLive = Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase)));",
    "  const commandRegistryLive = CommandRegistryLive.pipe(",
    "    Layer.provide(Layer.mergeAll(LandofileServiceLive, providerBase)),",
    "  );",
    "  const appBase = Layer.mergeAll(",
    "    providerBase,",
    "    buildOrchestratorLive,",
    "    LandofileServiceLive,",
    "    commandRegistryLive,",
    "    AppPlannerLive.pipe(Layer.provide(providerBase)),",
    "    ProviderExecToolingEngineLive,",
    "    ShellRunnerLive,",
    "    FileSyncEngineLive.pipe(Layer.provide(providerBase)),",
    "  );",
    "  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(appBase));",
    "  return Layer.merge(appBase, subscriberRuntimeLive);",
    "};",
    "",
  ].join("\n");

const renderNone = (): string =>
  ['import { Layer } from "effect";', "", "export const noneBootstrapLayer = Layer.empty;", ""].join("\n");

const renderIndex = (): string =>
  [
    'import { Layer } from "effect";',
    "",
    'import type { BootstrapLevel } from "@lando/sdk/schema";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { noneBootstrapLayer } from "./none.ts";',
    'import { makeMinimalBootstrapLayer } from "./minimal.ts";',
    'import { makePluginsBootstrapLayer } from "./plugins.ts";',
    'import { makeCommandsBootstrapLayer } from "./commands.ts";',
    'import { makeToolingBootstrapLayer } from "./tooling.ts";',
    'import { makeProviderBootstrapLayer } from "./provider.ts";',
    'import { makeGlobalBootstrapLayer } from "./global.ts";',
    'import { makeScratchBootstrapLayer } from "./scratch.ts";',
    'import { makeAppBootstrapLayer } from "./app.ts";',
    "",
    "export const makeGeneratedBootstrapLayer = (bootstrap: BootstrapLevel, inputs: BootstrapLayerInputs) => {",
    "  switch (bootstrap) {",
    '    case "none":',
    "      return noneBootstrapLayer;",
    '    case "minimal":',
    "      return makeMinimalBootstrapLayer(inputs);",
    '    case "plugins":',
    "      return makePluginsBootstrapLayer(inputs);",
    '    case "commands":',
    "      return makeCommandsBootstrapLayer(inputs);",
    '    case "tooling":',
    "      return makeToolingBootstrapLayer(inputs);",
    '    case "provider":',
    "      return makeProviderBootstrapLayer(inputs);",
    '    case "global":',
    "      return makeGlobalBootstrapLayer(inputs);",
    '    case "scratch":',
    "      return makeScratchBootstrapLayer(inputs);",
    '    case "app":',
    "      return makeAppBootstrapLayer(inputs);",
    "  }",
    "};",
    "",
    "export const mergeRuntimeWithHostLayers = (",
    "  baseLayer: Layer.Layer<unknown, unknown, unknown>,",
    "  hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>,",
    ") => (hostLayers.length === 0 ? baseLayer : Layer.mergeAll(baseLayer, ...hostLayers));",
    "",
  ].join("\n");

const renderers: Record<string, () => string> = {
  none: renderNone,
  minimal: renderMinimal,
  plugins: renderPlugins,
  commands: () => renderAlias("commands"),
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
    await writeFormattedOutput(output, `${HEADER()}\n${render()}`);
  }

  const expectedFiles = new Set(files.map((file) => `${file}.ts`));
  for (const file of await readdir(OUTPUT_DIR).catch(() => [])) {
    if (file.endsWith(".ts") && !expectedFiles.has(file)) await rm(resolve(OUTPUT_DIR, file));
  }

  console.log(
    `[build-bootstrap-layers] wrote ${OUTPUT_DIR} (${files.map((file) => basename(file)).length} files)`,
  );
};

await main();
