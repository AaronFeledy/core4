import type { SummaryTone } from "@lando/renderer/summary";
import type { BuiltImageCleanup, StartedService } from "@lando/sdk/schema";
import { appNetworkText, hostAddressText, routePatternText } from "./connection-summary";

export const summaryToneFromTable = (
  table: Readonly<Record<string, SummaryTone>>,
  fallback: SummaryTone,
): ((status: string) => SummaryTone) => {
  const tones = new Map(Object.entries(table));
  return (status) => tones.get(status) ?? fallback;
};

export const START_STATUS_TONES = {
  healthy: "ok",
  unknown: "info",
  paused: "skipped",
  running: "ok",
  ready: "ok",
  completed: "ok",
  restarting: "warn",
  starting: "pending",
  stopped: "skipped",
  unhealthy: "error",
  error: "error",
  failed: "error",
} as const satisfies Readonly<Record<string, SummaryTone>>;

export const INFO_STATUS_TONES = {
  ready: "ok",
  completed: "ok",
  restarting: "warn",
  paused: "skipped",
  unknown: "info",
  running: "ok",
  healthy: "ok",
  starting: "pending",
  stopped: "skipped",
  unhealthy: "error",
  error: "error",
} as const satisfies Readonly<Record<string, SummaryTone>>;

export const SCRATCH_STATUS_TONES = {
  attached: "ok",
  detached: "skipped",
  orphan: "error",
} as const satisfies Readonly<Record<string, SummaryTone>>;

export const serviceStateRow = (service: StartedService): string => {
  const host = hostAddressText(service);
  const patterns = routePatternText(service);
  const app = appNetworkText(service);
  const addresses = [
    ...(host.length === 0 && patterns.length === 0 ? [] : [`Host: ${host || "-"}`]),
    ...(patterns.length === 0 ? [] : [`Route patterns: ${patterns}`]),
    ...(app.length === 0 ? [] : [`App Network: ${app}`]),
  ];
  return `${service.name} (${service.state}) ${addresses.length === 0 ? "no endpoints" : addresses.join(" ")}`;
};

export const joinServiceRows = (rows: ReadonlyArray<string>): string => rows.join("; ");

export const serviceRowsText = (services: ReadonlyArray<StartedService>): string =>
  joinServiceRows(services.map(serviceStateRow));

export const lifecycleLine = (verb: string, app: string, rows: string): string =>
  `${verb}: ${app}${rows.length === 0 ? "" : ` - ${rows}`}`;

export const teardownLine = (
  verb: string,
  app: string,
  names: ReadonlyArray<string>,
  trailer?: string,
): string =>
  `${verb}: ${app} - ${names.length === 0 ? "no services" : names.join(", ")}${trailer === undefined ? "" : ` (${trailer})`}`;

export const unchangedLine = (app: string): string => teardownLine("unchanged", app, []);

/**
 * Reports the volume classes whose named volumes were actually removed. A class with no
 * removals is not a cleanup claim: `volumes preserved` means neither class removed anything.
 */
export const volumesTrailer = (data: boolean, cache: boolean, snapshotsRemoved = 0): string => {
  const classes = [...(data ? ["data"] : []), ...(cache ? ["cache"] : [])];
  const removed = [
    ...(classes.length === 0 ? [] : [`${classes.join(" and ")} volumes`]),
    ...(snapshotsRemoved === 0 ? [] : [`${snapshotsRemoved} snapshot${snapshotsRemoved === 1 ? "" : "s"}`]),
  ];
  return removed.length === 0 ? "volumes preserved" : `${removed.join(" and ")} removed`;
};

const builtImages = (count: number): string => `${count} built image${count === 1 ? "" : "s"}`;

export const builtImageCleanupLines = (
  cleanup: BuiltImageCleanup | undefined,
  purgeFlag = "--purge-caches",
): readonly string[] => {
  if (cleanup === undefined) return [];
  const lines: string[] = [];
  if (cleanup.released !== 0)
    lines.push(
      `Kept ${builtImages(cleanup.released)} for reuse for up to 7 days; ${purgeFlag} removes ${cleanup.released === 1 ? "it" : "them"}.`,
    );
  if (cleanup.removed !== 0) lines.push(`Removed ${builtImages(cleanup.removed)}.`);
  for (const image of cleanup.inUse)
    lines.push(
      `Kept image ${image.ref}: ${image.containers.length === 0 ? "in use" : `used by container ${image.containers.join(", ")}`}.`,
    );
  return lines;
};
