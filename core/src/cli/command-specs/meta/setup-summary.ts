/**
 * `meta:setup` completion summary rendering.
 *
 * Builds the decorated `SummaryDocument` (and its plain fallback lines) shown
 * after setup completes, mapping the file-sync status into a tone and a
 * human-readable line, and listing each host trust store the CA manages.
 */
import type { SummaryDocument, SummaryRow, SummarySection, SummaryTone } from "@lando/renderer/summary";
import type { TrustStoreChange } from "@lando/sdk/schema";

export const fileSyncStatusLine = (status: string): string => {
  switch (status) {
    case "deferred":
      return "file-sync: engine installation skipped (run lando setup to install later)";
    case "installed":
      return "file-sync: installed";
    case "unavailable":
      return "file-sync: unavailable (ordinary mounts remain available)";
    default:
      return "file-sync: already satisfied (ordinary bind mounts)";
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
  readonly trustStores?: ReadonlyArray<TrustStoreChange> | undefined;
}

const trustValue = ({ state, changed }: TrustStoreChange): string => (changed ? `${state} (updated)` : state);

/** Plain-text line for one trust store. */
export const trustStoreLine = (store: TrustStoreChange): string =>
  `trust: ${store.name}: ${trustValue(store)}`;

const trustRow = (store: TrustStoreChange): SummaryRow => ({
  label: store.name,
  tone: store.state === "trusted" ? "ok" : "warn",
  value: trustValue(store),
  ...(store.location === undefined ? {} : { detail: store.location }),
  ...(store.state === "trusted" || store.remediation === undefined ? {} : { remedy: store.remediation }),
});

/** Setup runs before any app plan, so this note never includes a CA count that could mismatch what a service actually trusts. */
export const caInjectionNote =
  "Configured host certificate authorities are set to inject into eligible type: lando services on the next plan or rebuild.";

export const buildSetupSummary = (input: SetupSummaryInput): SummaryDocument => {
  const status = input.fileSyncStatus;
  const trustStores = input.trustStores ?? [];
  const trustSection: ReadonlyArray<SummarySection> =
    trustStores.length === 0 ? [] : [{ title: "trust", rows: trustStores.map(trustRow) }];
  const degraded = status === "unavailable" || trustStores.some(({ state }) => state !== "trusted");
  return {
    title: "SETUP",
    subtitle: "complete",
    tone: degraded ? "warn" : "ok",
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
      ...trustSection,
    ],
    footer: `Lando runtime ready (${input.providerId})`,
  };
};
