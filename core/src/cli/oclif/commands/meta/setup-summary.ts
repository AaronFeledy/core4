/**
 * `meta:setup` completion summary rendering.
 *
 * Builds the decorated `SummaryDocument` (and its plain fallback line) shown
 * after setup completes, mapping the file-sync status into a tone and a
 * human-readable line.
 */
import type { SummaryDocument, SummaryTone } from "../../../renderer/summary.ts";

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

export const buildSetupSummary = (
  providerId: string,
  installDir: string,
  status: string,
): SummaryDocument => ({
  title: "SETUP",
  subtitle: "complete",
  tone: status === "unavailable" ? "warn" : "ok",
  sections: [
    {
      title: "runtime",
      rows: [
        { label: "provider", tone: "ok", value: providerId },
        { label: "file-sync", tone: fileSyncTone(status), value: status, detail: fileSyncStatusLine(status) },
        { label: "install dir", tone: "info", fields: [{ label: "LANDO_INSTALL_DIR", value: installDir }] },
      ],
    },
  ],
  footer: `Lando runtime ready (${providerId})`,
});
