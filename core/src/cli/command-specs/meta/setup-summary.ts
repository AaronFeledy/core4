/**
 * `meta:setup` completion summary rendering.
 *
 * Builds the decorated `SummaryDocument` (and its plain fallback line) shown
 * after setup completes, mapping the file-sync status into a tone and a
 * human-readable line.
 */
import type { SummaryDocument, SummaryTone } from "../../renderer/summary";

export const fileSyncStatusLine = (status: string): string => {
  switch (status) {
    case "deferred":
      return "file-sync: deferred until first accelerated app:start";
    case "installed":
      return "file-sync: installed";
    case "unavailable":
      return "file-sync: unavailable (userDataRoot is not configured)";
    default:
      return "file-sync: already satisfied (native bind mounts)";
  }
};

const fileSyncTone = (status: string): SummaryTone => {
  switch (status) {
    case "deferred":
      return "pending";
    case "unavailable":
      return "warn";
    default:
      return "ok";
  }
};

export interface SetupSummaryInput {
  readonly providerId: string;
  readonly installDir: string;
  readonly fileSyncStatus: string;
  readonly notes: ReadonlyArray<string>;
}

/** Setup runs before any app plan, so this note never includes a CA count that could mismatch what a service actually trusts. */
export const caInjectionNote =
  "Configured host certificate authorities are set to inject into eligible type: lando services on the next plan or rebuild.";

export const buildSetupSummary = (input: SetupSummaryInput): SummaryDocument => {
  const status = input.fileSyncStatus;
  return {
    title: "SETUP",
    subtitle: "complete",
    tone: status === "unavailable" ? "warn" : "ok",
    sections: [
      {
        title: "runtime",
        rows: [
          { label: "provider", tone: "ok", value: input.providerId },
          {
            label: "file-sync",
            tone: fileSyncTone(status),
            value: status,
            detail: fileSyncStatusLine(status),
          },
          {
            label: "install dir",
            tone: "info",
            fields: [{ label: "LANDO_INSTALL_DIR", value: input.installDir }],
          },
        ],
        ...(input.notes.length === 0 ? {} : { notes: input.notes }),
      },
    ],
    footer: `Lando runtime ready (${input.providerId})`,
  };
};
