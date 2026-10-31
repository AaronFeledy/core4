/**
 * `lando app:destroy` — native command metadata adapter.
 */
import { resolve } from "node:path";
import { destroyApp, destroyAppAtRoot } from "@lando/engine/operations/destroy";
import { DestroyAppResult, ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { renderDestroyAppResult } from "../../commands/destroy";
import { requireConfirmation } from "../../require-confirmation";
import type { LandoCommandSpec } from "../../spec/command-base";
import { yesFlag } from "../../spec/confirmation-flag";
import { booleanFlag, specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

/**
 * Prompts render as a one-line title, so the data loss comes first and the (possibly long) folder
 * path last: when the title is cut, the path the user just typed is what gets cut.
 */
const destroyConfirmation = (
  root: string | undefined,
  deletes: { readonly volumes: boolean; readonly snapshots: boolean; readonly caches: boolean },
): string => {
  const items = [
    "containers",
    ...(deletes.volumes ? ["data volumes"] : []),
    ...(deletes.snapshots ? ["snapshots"] : []),
    ...(deletes.caches ? ["cache volumes"] : []),
  ];
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const subject = root === undefined ? `this app's ${list}` : `the ${list} left by ${root}`;
  return `Delete ${subject}?${deletes.volumes ? "" : " Named data volumes are kept."}`;
};

export const runDestroyCommand = Effect.fn("DestroyCommand.run")(function* (input: unknown) {
  const flags = specFlagsOf(input);
  const volumes = booleanFlag(flags, "volumes") || booleanFlag(flags, "purge");
  const rootFlag = stringFlag(flags, "root");
  const root = rootFlag === undefined ? undefined : resolve(process.cwd(), rootFlag);
  yield* requireConfirmation({
    yes: booleanFlag(flags, "yes"),
    message: destroyConfirmation(root, {
      volumes,
      snapshots: booleanFlag(flags, "purge"),
      caches: booleanFlag(flags, "purge-caches"),
    }),
  });
  const options = {
    ...(stringFlag(flags, "provider") === undefined
      ? {}
      : { providerId: ProviderId.make(stringFlag(flags, "provider") ?? "") }),
    volumes,
    purgeCaches: booleanFlag(flags, "purge-caches"),
    purgeSnapshots: booleanFlag(flags, "purge"),
    yes: booleanFlag(flags, "yes"),
  };
  return yield* root === undefined ? destroyApp(options) : destroyAppAtRoot(root, options);
});

export const destroySpec: LandoCommandSpec<DestroyAppResult> = {
  resultSchema: DestroyAppResult,
  id: "app:destroy",
  helpGroup: "common",
  summary: "Destroy the current Lando app (preserves named volumes unless --purge or --volumes).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: {
    provider: Flags.string({ description: "Destroy only this provider's applied app and owned resources." }),
    root: Flags.string({
      description: "Clean up an app whose folder no longer exists, using the path lando doctor prints.",
    }),
    volumes: Flags.boolean({
      description: "Also remove app/service-scoped storage volumes.",
      default: false,
    }),
    purge: Flags.boolean({
      description:
        "Also remove app/service-scoped storage volumes and this folder's snapshots, including provider-stored data.",
      default: false,
    }),
    "purge-caches": Flags.boolean({
      description: "Remove cache storage volumes.",
      default: false,
    }),
    yes: yesFlag("Skip the confirmation prompt."),
  },
  run: runDestroyCommand,
  render: (result) => renderDestroyAppResult(result as DestroyAppResult),
};
