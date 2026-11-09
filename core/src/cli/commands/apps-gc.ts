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

export const renderAppsGcReport = (report: AppsGcReport): string =>
  [
    `${report.candidates.length} missing app root${report.candidates.length === 1 ? "" : "s"}.`,
    ...report.unreadableJournals.map(
      (journal) =>
        `Unreadable journal ${journal.path}: ${journal._tag}: ${journal.message} ${journal.remediation}`,
    ),
    // A provider that never recorded a missing root has nothing for this report to miss.
    ...report.scans
      .filter(
        (scan) =>
          !scan.complete &&
          (scan.errorTag !== undefined ||
            report.candidates.some((root) => root.providers.includes(scan.providerId))),
      )
      .map((scan) => `${scan.providerId}: ${scan.message}`),
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
