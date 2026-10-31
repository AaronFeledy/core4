import { bundledPluginModules } from "@lando/engine/composition";
import {
  type GraphCommandCandidate,
  PluginContributionGraph,
} from "@lando/engine/plugins/contribution-graph";
import { pluginCommandCandidates } from "@lando/engine/plugins/contribution-graph";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { Context, Effect, Result } from "effect";
import "../../src/runtime/bundled-plugins";
import { Schema } from "effect";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry";
import { mcpRegistryFromBuiltIns } from "../../src/cli/commands/meta/mcp-registry";
import { mcpRegistryWithPlugins } from "../../src/mcp-plugins";

export const bundledMcpRegistry = () => {
  const plugins = bundledPluginModules().map((module) => ({
    manifest: module.manifest,
    module,
    source: "bundled" as const,
  }));
  const graph = {
    plugins,
    globalPlugins: plugins,
    commands: Result.getOrThrow(pluginCommandCandidates(plugins)),
    certificateAuthorities: [],
    hostContext: Context.empty(),
  };
  return mcpRegistryWithPlugins(mcpRegistryFromBuiltIns(builtInCommandEntries)).pipe(
    Effect.provideService(PluginContributionGraph, graph),
  );
};

export const pluginFixtureGraph = (
  spec: ExecutableCommandSpec,
  options: {
    readonly source?: GraphCommandCandidate["source"];
    readonly mcpAllowed?: boolean;
  } = {},
) => {
  const source = options.source ?? "user";
  const descriptor = {
    id: spec.id,
    summary: spec.summary ?? "Fixture command",
    mcpAllowed: options.mcpAllowed ?? true,
  };
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/mcp",
    version: "1.0.0",
    api: 4,
    contributes: { commands: [descriptor] },
  });
  const plugins = [{ manifest, source }];
  return {
    plugins,
    globalPlugins: source === "app" ? [] : plugins,
    certificateAuthorities: [],
    hostContext: Context.empty(),
    commands: [
      { id: spec.id, pluginName: String(manifest.name), source, descriptor, load: async () => spec },
    ],
  };
};
