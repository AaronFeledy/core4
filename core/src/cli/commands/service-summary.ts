import type { StartedService } from "@lando/sdk/schema";

import type { SummaryTone } from "@lando/renderer/summary";
import { scopedConnectionText } from "./connection-summary";

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
  const host = scopedConnectionText(service.connections, "host");
  const app = scopedConnectionText(service.connections, "app");
  const addresses = [
    ...(host.length === 0 ? [] : [`Host: ${host}`]),
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

export const volumesTrailer = (removed: boolean, snapshotsRemoved = 0): string => {
  if (snapshotsRemoved === 0) return removed ? "volumes removed" : "volumes preserved";
  const snapshots = `${snapshotsRemoved} snapshot${snapshotsRemoved === 1 ? "" : "s"}`;
  return removed ? `volumes and ${snapshots} removed` : `${snapshots} removed`;
};
