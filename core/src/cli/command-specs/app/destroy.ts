/**
 * `lando app:destroy` — native command metadata adapter.
 */
import { resolve } from "node:path";
import { Effect } from "effect";
import { Flags } from "../../spec/metadata";

import {
  type DestroyAppResult,
  DestroyAppResultSchema,
  destroyApp,
  destroyAppAtRoot,
} from "@lando/engine/operations/destroy";
import { renderDestroyAppResult } from "../../commands/destroy";
import { requireConfirmation } from "../../require-confirmation";
import type { LandoCommandSpec } from "../../spec/command-base";
import { extractSpecFlags } from "../../spec/command-boundary";

/**
 * Prompts render as a one-line title, so the data loss comes first and the (possibly long) folder
 * path last: when the title is cut, the path the user just typed is what gets cut.
 */
const rootConfirmation = (
  root: string,
  deletes: { readonly volumes: boolean; readonly snapshots: boolean; readonly caches: boolean },
): string => {
  const items = [
    "containers",
    ...(deletes.volumes ? ["data volumes"] : []),
    ...(deletes.snapshots ? ["snapshots"] : []),
    ...(deletes.caches ? ["cache volumes"] : []),
  ];
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return `Delete the ${list} left by ${root}?${deletes.volumes ? "" : " Data volumes are kept."}`;
};

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
    const root = typeof flags.root === "string" ? resolve(process.cwd(), flags.root) : undefined;
    yield* requireConfirmation({
      yes: flags.yes === true,
      message:
        root === undefined
          ? `Destroy this app? This removes containers and networks. ${storage}${flags["purge-caches"] === true ? " Cache volumes are deleted too." : ""}`
          : rootConfirmation(root, {
              volumes,
              snapshots: flags.purge === true,
              caches: flags["purge-caches"] === true,
            }),
    });
    const options = {
      volumes,
      purgeCaches: flags["purge-caches"] === true,
      yes: flags.yes === true,
    };
    return yield* root === undefined ? destroyApp(options) : destroyAppAtRoot(root, options);
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
    root: Flags.string({
      description: "Clean up an app whose folder no longer exists, using the path lando doctor prints.",
    }),
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
