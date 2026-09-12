import { Effect } from "effect";

import { Flags } from "../../spec/metadata";

import {
  type UpdateOptions,
  type UpdateResult,
  UpdateResultSchema,
  makeUpdateHandoff,
  update,
} from "@lando/engine/operations/update";
import { StateStore } from "@lando/sdk/services";
import { makePluginUpdateRunner } from "../../commands/update-plugins";
import type { LandoCommandSpec } from "../../spec/command-base";

export const updateOptionsFromInput = (input: unknown): UpdateOptions => {
  const flags =
    typeof input === "object" && input !== null
      ? ((input as { readonly flags?: Record<string, unknown> }).flags ?? {})
      : {};
  const channel = flags.channel;
  const only = flags.only;
  return {
    ...(channel === "stable" || channel === "next" || channel === "dev" ? { channel } : {}),
    dryRun: flags["dry-run"] === true,
    ...(only === "core" || only === "plugins" ? { only } : {}),
    // The CLI shell owns process-entry facts; the engine operation must not
    // read process.argv itself (engine-closure), so supply the re-exec argv here.
    selfUpdate: { argv: process.argv },
  };
};

export const runUpdateCommand = (input: unknown) =>
  Effect.gen(function* () {
    const runPluginUpdates = yield* makePluginUpdateRunner();
    const stateStore = yield* StateStore;
    const handoff = makeUpdateHandoff(stateStore, process.env.LANDO_UPDATE_HANDOFF_TOKEN);
    return yield* update({ ...updateOptionsFromInput(input), runPluginUpdates, handoff });
  });

export const renderUpdateResult = (result: UpdateResult): string => {
  const coreStatus = result.coreBlocked
    ? "blocked"
    : result.updatedCore
      ? "updated"
      : result.coreUpdateAvailable
        ? "available"
        : "unchanged";
  const core = `core: ${coreStatus}`;
  const plugins = (result.pluginResults ?? []).map((row) =>
    [
      `plugin: ${row.name}`,
      `status: ${row.status}`,
      `current: ${row.currentVersion}`,
      ...(row.targetVersion === undefined ? [] : [`target: ${row.targetVersion}`]),
      `reason: ${row.reason}`,
    ].join("\n"),
  );
  return [core, ...plugins].join("\n\n");
};

export const updateSpec: LandoCommandSpec<UpdateResult> = {
  resultSchema: UpdateResultSchema,
  id: "meta:update",
  summary: "Update Lando core and plugins.",
  description: "Update Lando core and plugins.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  successExitCode: (result) => (result.hasFailures === true ? 1 : undefined),
  flags: {
    channel: Flags.string({
      description: "Release channel to resolve.",
      options: ["stable", "next", "dev"],
    }),
    only: Flags.string({
      description: "Update only core or registry-installed plugins.",
      options: ["core", "plugins"],
    }),
    "dry-run": Flags.boolean({
      description: "Verify update metadata without replacing the binary.",
      default: false,
    }),
  },
  run: runUpdateCommand,
  render: (result) => renderUpdateResult(result as UpdateResult),
};
