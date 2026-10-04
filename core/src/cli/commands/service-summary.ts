import type { SummaryTone } from "@lando/renderer/summary";

export const summaryToneFromTable = (
  table: Readonly<Record<string, SummaryTone>>,
  fallback: SummaryTone,
): ((status: string) => SummaryTone) => {
  const tones = new Map(Object.entries(table));
  return (status) => tones.get(status) ?? fallback;
};

export const START_STATUS_TONES = {
  running: "ok",
  ready: "ok",
  starting: "pending",
  stopped: "skipped",
  unhealthy: "error",
  error: "error",
  failed: "error",
} as const satisfies Readonly<Record<string, SummaryTone>>;

export const INFO_STATUS_TONES = {
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

export const endpointText = (endpoints: ReadonlyArray<string>): string =>
  endpoints.length === 0 ? "no endpoints" : endpoints.join(", ");

export const serviceStateRow = (name: string, state: string, endpoints: ReadonlyArray<string>): string =>
  `${name} (${state}) ${endpointText(endpoints)}`;

export const joinServiceRows = (rows: ReadonlyArray<string>): string => rows.join("; ");
