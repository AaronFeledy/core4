/**
 * `lando app:destroy` — native command metadata adapter.
 */
import { Effect } from "effect";
import { Flags } from "../../spec/metadata";

import { type DestroyAppResult, DestroyAppResultSchema, destroyApp } from "@lando/engine/operations/destroy";
import { renderDestroyAppResult } from "../../commands/destroy";
import { requireConfirmation } from "../../require-confirmation";
import type { LandoCommandSpec } from "../../spec/command-base";
import { extractSpecFlags } from "../../spec/command-boundary";

export const runDestroyCommand = (input: unknown) => {
  const flags = extractSpecFlags(input);
  const volumes = flags.volumes === true || flags.purge === true;
  const storage =
    flags.purge === true
      ? "Volumes and snapshots are deleted too."
      : volumes
        ? "Volumes are deleted too."
        : "Data volumes are kept.";
  return Effect.gen(function* () {
    yield* requireConfirmation({
      yes: flags.yes === true,
      message: `Destroy this app? This removes containers and networks. ${storage}${flags["purge-caches"] === true ? " Cache volumes are deleted too." : ""}`,
    });
    return yield* destroyApp({
      volumes,
      purgeCaches: flags["purge-caches"] === true,
      yes: flags.yes === true,
    });
  });
};

export const destroySpec: LandoCommandSpec<DestroyAppResult> = {
  resultSchema: DestroyAppResultSchema,
  id: "app:destroy",
  helpGroup: "common",
  summary: "Destroy the current Lando app (preserves volumes unless --purge or --volumes).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: {
    volumes: Flags.boolean({
      description: "Also remove app/service-scoped storage volumes.",
      default: false,
    }),
    purge: Flags.boolean({
      description: "Also remove app/service-scoped storage volumes and snapshots.",
      default: false,
    }),
    "purge-caches": Flags.boolean({
      description: "Remove cache storage volumes.",
      default: false,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Skip the confirmation prompt.",
      default: false,
    }),
  },
  run: runDestroyCommand,
  render: (result) => renderDestroyAppResult(result as DestroyAppResult),
};
