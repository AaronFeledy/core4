import { Args, Flags } from "@oclif/core";
import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

import { type PluginAddResult, pluginAdd, renderPluginAddResult } from "../../../../commands/plugin-add.ts";
import { resolveNonInteractive } from "../../../../prompts/answer-flags.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractInput = (input: unknown): { spec: string; trust: boolean; force: boolean; yes: boolean } => {
  if (typeof input !== "object" || input === null) {
    return { spec: "", trust: false, force: false, yes: false };
  }
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return {
    spec: typeof args.spec === "string" ? args.spec : "",
    trust: flags.trust === true,
    force: flags.force === true,
    yes: flags.yes === true,
  };
};

const missingSpecError = (): NotImplementedError =>
  new NotImplementedError({
    message: "meta:plugin:add requires a plugin spec argument.",
    commandId: "meta:plugin:add",
    remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
  });

export const pluginAddSpec: LandoCommandSpec<PluginAddResult> = {
  id: "meta:plugin:add",
  summary: "Install a plugin (npm source) with manifest validation and trust prompt.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) =>
    Effect.gen(function* () {
      const parsed = extractInput(input);
      if (parsed.spec === "") {
        return yield* Effect.fail(missingSpecError());
      }
      return yield* pluginAdd({
        spec: parsed.spec,
        trust: parsed.trust || parsed.yes,
        nonInteractive: resolveNonInteractive({ isTTY: process.stdin.isTTY }),
      });
    }),
  render: (result) => renderPluginAddResult(result as PluginAddResult),
};

export default class PluginAddCommand extends LandoCommandBase {
  static override description = pluginAddSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginAddSpec)];
  static override args = {
    spec: Args.string({
      description: "Plugin spec (npm package name with optional @version).",
      required: false,
    }),
  };
  static override flags = {
    trust: Flags.boolean({
      description:
        "Trust the plugin for this session (required for non-interactive installs; persistent trust is deferred to Beta).",
      default: false,
    }),
    yes: Flags.boolean({ char: "y", description: "Alias of --trust.", default: false }),
    force: Flags.boolean({ description: "Re-install even if already present.", default: false }),
  };
  static override landoSpec: LandoCommandSpec = pluginAddSpec;
  static override bootstrap = pluginAddSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginAddSpec);
  }
}
