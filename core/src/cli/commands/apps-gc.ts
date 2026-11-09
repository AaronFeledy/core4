import type { AppsGcReport } from "@lando/engine/operations/apps-gc";

const counted = (count: number, noun: string): string | undefined =>
  count === 0 ? undefined : `${count} ${noun}${count === 1 ? "" : "s"}`;

const holdings = (root: AppsGcReport["candidates"][number]): string =>
  [
    counted(root.services.length, "container"),
    counted(root.dataVolumes.length, "data volume"),
    counted(root.cacheVolumes.length, "cache volume"),
    counted(root.journals.length, "unfinished start"),
  ]
    .filter((part) => part !== undefined)
    .join(", ") || "recorded state only";

export const renderAppsGcReport = (report: AppsGcReport): string => {
  const incomplete = report.scans.filter((scan) => !scan.complete);
  const explained = incomplete.filter(
    (scan) =>
      scan.errorTag !== undefined ||
      report.candidates.some((root) => root.providers.includes(scan.providerId)),
  );
  // Unobserved providers that hold no candidate share one line; their leftovers can only be orphans.
  const unobserved = incomplete.filter((scan) => !explained.includes(scan)).map((scan) => scan.providerId);
  return [
    `${report.candidates.length} missing app root${report.candidates.length === 1 ? "" : "s"}.`,
    ...report.unreadableJournals.map(
      (journal) =>
        `Unreadable journal ${journal.path}: ${journal._tag}: ${journal.message} ${journal.remediation}`,
    ),
    ...explained.map((scan) => `${scan.providerId}: ${scan.message}`),
    ...(unobserved.length === 0
      ? []
      : [`Not observed (their containers and volumes are not listed): ${unobserved.join(", ")}.`]),
    ...(report.prune
      ? report.roots.map(
          (root) =>
            `${root.outcome}: ${root.root}: ${root.reason}${root.error === undefined ? "" : ` ${root.error.remediation}`}`,
        )
      : report.candidates.map((root) => `${root.root} (${root.providers.join(", ")}: ${holdings(root)})`)),
    ...(report.prune
      ? [`Removed ${report.completedJournalsRemoved} completed journal documents.`]
      : [
          "Run lando apps:gc --prune to clean up; add --volumes to delete data and file-sync copies of app files.",
        ]),
  ].join("\n");
};
