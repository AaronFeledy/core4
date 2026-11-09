import { AppsGcReport, prepareAppsGc } from "@lando/engine/operations/apps-gc";
import type { DestroyAppOptions } from "@lando/sdk/app";
import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { renderAppsGcReport } from "../../commands/apps-gc";
import { requireConfirmation } from "../../require-confirmation";
import type { LandoCommandSpec } from "../../spec/command-base";
import { yesFlag } from "../../spec/confirmation-flag";
import { booleanFlag, specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const appsGcConfirmation = (report: AppsGcReport, options: DestroyAppOptions): string => {
  const keptCopies = report.candidates.some((root) => !root.fileSyncCopiesRemovable);
  const deleted = [
    "containers",
    ...(options.volumes
      ? [
          keptCopies
            ? "data volumes and supported file-sync copies of app files (unsupported roots fail before deletion)"
            : "data volumes and file-sync copies of app files",
        ]
      : []),
    ...(options.purgeCaches ? ["cache volumes"] : []),
    ...(options.purgeSnapshots ? ["snapshots"] : []),
  ];
  const kept = [
    ...(options.volumes ? [] : ["data volumes and file-sync copies of app files"]),
    ...(options.volumes && keptCopies ? ["unsupported file-sync copies"] : []),
    ...(options.purgeCaches ? [] : ["cache volumes"]),
    ...(options.purgeSnapshots ? [] : ["snapshots"]),
  ];
  const candidates = report.candidates.map((root) => {
    const targets = root.journals.flatMap((journal) => journal.targets.map((target) => target.volumeName));
    return [
      `${root.root} (${root.providers.join(", ")})`,
      `  Delete containers: ${root.services.join(", ") || "none observed"}`,
      `  ${options.volumes ? "Delete" : "Keep"} data volumes: ${root.dataVolumes.join(", ") || "none observed"}`,
      `  ${options.volumes && root.fileSyncCopiesRemovable ? "Delete" : "Keep"} file-sync copies: ${targets.join(", ") || "none recorded"}${root.fileSyncCopiesRemovable ? "" : "; Lando cannot remove this provider's file-sync copies of a deleted app yet. Rerun without --volumes to remove everything else."}`,
      `  ${options.purgeCaches ? "Delete" : "Keep"} cache volumes: ${root.cacheVolumes.join(", ") || "none observed"}`,
      `  Recorded applied state: ${root.appliedState ? "yes" : "no"}; unfinished journals: ${root.journals.length}`,
      ...(root.runtimeObserved ? [] : ["  Runtime not observed; live holdings are unknown."]),
    ].join("\n");
  });
  return [
    `Delete ${deleted.join(", ")} for these missing app roots?${kept.length === 0 ? "" : ` Keep ${kept.join(", ")}.`}`,
    ...candidates,
    ...(candidates.length === 0 ? ["(none)"] : []),
    `Snapshots are not inventoried here; ${options.purgeSnapshots ? "delete candidate roots' snapshots" : "keep snapshots"}.`,
    ...report.scans
      .filter((scan) => !scan.complete && (scan.recordedState || scan.errorTag !== undefined))
      .map((scan) => `${scan.providerId}: ${scan.message}`),
    "Remove completed accelerated-start journal documents (revalidated during the sweep).",
    "Revalidate each root and its ownership before deletion; changed evidence is retained.",
  ].join("\n");
};

export const runAppsGcCommand = Effect.fn("AppsGcCommand.run")(function* (input: unknown) {
  const flags = specFlagsOf(input);
  const provider = stringFlag(flags, "provider");
  const options: DestroyAppOptions = {
    ...(provider === undefined ? {} : { providerId: ProviderId.make(provider) }),
    volumes: booleanFlag(flags, "volumes") || booleanFlag(flags, "purge"),
    purgeCaches: booleanFlag(flags, "purge-caches"),
    purgeSnapshots: booleanFlag(flags, "purge"),
    yes: booleanFlag(flags, "yes"),
  };
  const prepared = yield* prepareAppsGc(options, { prune: booleanFlag(flags, "prune") });
  if (!booleanFlag(flags, "prune")) return prepared.report;
  yield* requireConfirmation({
    yes: options.yes === true,
    message: appsGcConfirmation(prepared.report, options),
  });
  return yield* prepared.prune;
});

export const appsGcSpec: LandoCommandSpec<AppsGcReport> = {
  id: "apps:gc",
  namespace: "apps",
  summary: "Report or clean up user apps whose folders no longer exist.",
  bootstrap: "provider",
  resultSchema: AppsGcReport,
  flags: {
    prune: Flags.boolean({
      default: false,
      description: "Confirm once, then clean up the reported missing app roots.",
    }),
    volumes: Flags.boolean({
      default: false,
      description: "Delete data volumes and file-sync copies of app files.",
    }),
    purge: Flags.boolean({
      default: false,
      description: "Delete data volumes, file-sync copies of app files, and snapshots.",
    }),
    "purge-caches": Flags.boolean({ default: false, description: "Delete cache volumes." }),
    provider: Flags.string({ description: "Inspect and clean up only this provider." }),
    yes: yesFlag("Skip the confirmation prompt."),
  },
  run: runAppsGcCommand,
  render: renderAppsGcReport,
  completion: (report) =>
    report.prune &&
    (report.unreadableJournals.length > 0 ||
      report.roots.some(
        (root) => root.confirmed && (root.outcome === "failed" || root.outcome === "retained"),
      ))
      ? { ok: false, exitCode: 1 }
      : { ok: true, exitCode: 0 },
};
