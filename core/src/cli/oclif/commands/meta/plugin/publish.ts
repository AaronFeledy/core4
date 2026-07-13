import { Flags } from "@oclif/core";

import {
  type PluginPublishOptions,
  type PluginPublishResult,
  PluginPublishResultSchema,
  pluginPublish,
  renderPluginPublishResult,
} from "../../../../commands/plugin-publish.ts";
import { resolveNonInteractive } from "../../../../prompts/answer-flags.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractInput = (input: unknown): PluginPublishOptions => {
  const flags =
    typeof input === "object" && input !== null
      ? ((input as { flags?: Record<string, unknown> }).flags ?? {})
      : {};
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;
  const registry = typeof flags.registry === "string" ? flags.registry : undefined;
  return {
    ...(tag === undefined ? {} : { tag }),
    ...(registry === undefined ? {} : { registry }),
    dryRun: flags["dry-run"] === true,
    noTest: flags["no-test"] === true,
    nonInteractive: resolveNonInteractive({
      noInteractive: flags["no-interactive"] === true,
      isTTY: process.stdin.isTTY,
    }),
  };
};

export const pluginPublishSpec: LandoCommandSpec<PluginPublishResult> = {
  resultSchema: PluginPublishResultSchema,
  id: "meta:plugin:publish",
  summary: "Publish the current plugin (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: (input) => pluginPublish(extractInput(input)),
  successExitCode: (result) => (result.exitCode === 0 ? undefined : result.exitCode),
  render: (result) => renderPluginPublishResult(result as PluginPublishResult),
};

export default class PluginPublishCommand extends LandoCommandBase {
  static override description = pluginPublishSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginPublishSpec)];
  static override flags = {
    tag: Flags.string({ description: "Publish dist-tag (default: latest)." }),
    registry: Flags.string({ description: "Registry URL override." }),
    "dry-run": Flags.boolean({
      description: "Validate and list package contents without publishing.",
      default: false,
    }),
    "no-test": Flags.boolean({ description: "Skip retesting before publish.", default: false }),
    "no-interactive": Flags.boolean({ description: "Never prompt for credentials.", default: false }),
  };
  static override landoSpec: LandoCommandSpec = pluginPublishSpec;
  static override bootstrap = pluginPublishSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginPublishSpec);
  }
}
