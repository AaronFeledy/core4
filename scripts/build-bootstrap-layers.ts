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
import { renderCommands, renderIndex, renderMinimal, renderProvider } from "./bootstrap-layer-renderers.ts";

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
    'import { Context, Layer } from "effect";',
    "",
    'import { EventService } from "@lando/sdk/services";',
    'import { DeprecationPluginRegistryLive } from "../../../deprecation/plugin-registry.ts";',
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
    "  return Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive, deprecationRegistryLive).pipe(",
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
    'import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makeCommandsBootstrapBaseLayer } from "./commands.ts";',
    "",
    "export const makeToolingBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const toolingBase = makeCommandsBootstrapBaseLayer(inputs);",
    "  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(toolingBase));",
    "  return Layer.merge(toolingBase, subscriberRuntimeLive).pipe(",
    '    Layer.tap((context) => inputs.lifecycle.complete("tooling", Context.get(context, EventService))),',
    "  );",
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
    "    plannerLive,",
    "    buildOrchestratorLive,",
    "    ScratchRegistryLive,",
    "    ScratchResourceScannerLive,",
    "  );",
    "  return Layer.mergeAll(",
    "    providerBase,",
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
    'import { Context, Layer } from "effect";',
    "",
    'import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";',
    'import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";',
    'import { EventService } from "@lando/sdk/services";',
    'import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";',
    'import { GlobalAppRuntimeLive } from "../../../global-app/runtime.ts";',
    'import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";',
    'import { AppPlannerLive } from "../../../services/planner.ts";',
    'import { ShellRunnerLive } from "../../../services/shell-runner.ts";',
    'import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";',
    'import { ProxyServiceRegistryLive, SelectedProxyServiceLive } from "../../../subsystems/proxy/registry.ts";',
    'import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";',
    'import { makeProviderBootstrapBaseLayer } from "./provider.ts";',
    "",
    "export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {",
    "  const providerBase = makeProviderBootstrapBaseLayer(inputs);",
    "  const buildOrchestratorLive = Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase)));",
    "  const appBase = Layer.mergeAll(",
    "    providerBase,",
    "    buildOrchestratorLive,",
    "    AppPlannerLive.pipe(Layer.provide(providerBase)),",
    "    ProviderExecToolingEngineLive,",
    "    ShellRunnerLive,",
    "    FileSyncEngineLive.pipe(Layer.provide(providerBase)),",
    "  );",
    "  const proxyRegistryLive = ProxyServiceRegistryLive.pipe(",
    "    Layer.provide(appBase),",
    "    Layer.mapError((cause) =>",
    '      new LandoRuntimeBootstrapError({ message: cause instanceof Error ? cause.message : "ProxyService bootstrap failed.", stage: "app", cause }),',
    "    ),",
    "  );",
    "  const globalAppRuntimeLive = GlobalAppRuntimeLive.pipe(Layer.provide(appBase));",
    "  const proxyServiceLive = SelectedProxyServiceLive.pipe(",
    "    Layer.provide(Layer.mergeAll(appBase, globalAppRuntimeLive, proxyRegistryLive)),",
    "    Layer.mapError((cause) =>",
    '      new LandoRuntimeBootstrapError({ message: cause instanceof Error ? cause.message : "ProxyService bootstrap failed.", stage: "app", cause }),',
    "    ),",
    "  );",
    "  const fullAppBase = Layer.mergeAll(appBase, globalAppRuntimeLive, proxyRegistryLive, proxyServiceLive);",
    "  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(fullAppBase));",
    "  return Layer.merge(fullAppBase, subscriberRuntimeLive).pipe(",
    '    Layer.tap((context) => inputs.lifecycle.complete("app", Context.get(context, EventService))),',
    "  );",
    "};",
    "",
  ].join("\n");

const renderNone = (): string =>
  ['import { Layer } from "effect";', "", "export const noneBootstrapLayer = Layer.empty;", ""].join("\n");

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
