import type { CompatibilityException, CompatibilityFinding, PersistedStoreId } from "./model.ts";
import { persistedMigrationRemediation } from "./persisted.ts";

export interface AcceptCompatibilityOptions {
  readonly persistedStoresBySurface?: ReadonlyMap<string, ReadonlySet<PersistedStoreId>>;
  readonly storeVersions?: Readonly<Partial<Record<PersistedStoreId, number>>>;
  readonly baseStoreVersions?: Readonly<Partial<Record<PersistedStoreId, number>>>;
}

const acceptPersistedWidening = (
  entry: CompatibilityFinding,
  stores: ReadonlySet<PersistedStoreId>,
  options: AcceptCompatibilityOptions,
): CompatibilityFinding | undefined => {
  const needBump: string[] = [];
  for (const store of [...stores].sort()) {
    const current = options.storeVersions?.[store];
    const baseline = options.baseStoreVersions?.[store];
    if (current === undefined || baseline === undefined) return undefined;
    if (current <= baseline) needBump.push(`${store} (current ${current}, baseline ${baseline})`);
  }
  return needBump.length === 0
    ? { ...entry, accepted: true }
    : {
        ...entry,
        verdict: "breaking",
        message: `${entry.message} Bump the persisted store version above baseline: ${needBump.join(", ")}. No record rewrite or exception is needed for widening.`,
      };
};

/** The reviewed exception for this exact change at this surface path, if any. */
export const findCompatibilityException = (
  exceptions: ReadonlyArray<CompatibilityException>,
  surface: string,
  entry: CompatibilityFinding,
): CompatibilityException | undefined =>
  exceptions.find(
    (candidate) =>
      candidate.fingerprint === entry.fingerprint &&
      candidate.changeKind === entry.changeKind &&
      candidate.locations.some((location) => location.surface === surface && location.path === entry.path),
  );

export const acceptCompatibilityExceptions = (
  surface: string,
  findings: ReadonlyArray<CompatibilityFinding>,
  exceptions: ReadonlyArray<CompatibilityException>,
  options: AcceptCompatibilityOptions = {},
): ReadonlyArray<CompatibilityFinding> => {
  const persistedStores = options.persistedStoresBySurface?.get(surface);
  return findings.map((finding) => {
    const versionOnly = finding.persistedWidening === "version-only";
    const versioned =
      versionOnly && persistedStores !== undefined
        ? acceptPersistedWidening(finding, persistedStores, options)
        : undefined;
    if (versioned !== undefined) return versioned;
    const entry: CompatibilityFinding = versionOnly
      ? {
          ...finding,
          verdict: "unknown",
          persistedWidening: "review",
          message: `${finding.message} Cannot verify a version advance for every affected store.`,
        }
      : finding;
    if (entry.verdict === "compatible") return entry;
    const exception = findCompatibilityException(exceptions, surface, entry);
    const widening = entry.persistedWidening === "review";
    const storeVersions = options.storeVersions ?? (widening ? {} : undefined);
    if (persistedStores === undefined || storeVersions === undefined) {
      return exception === undefined
        ? entry
        : { ...entry, accepted: true, justification: exception.justification };
    }
    const remediation = widening
      ? "Record the current version of every affected store in exception.persistedState. No payload rewrite is required for widening."
      : persistedMigrationRemediation(persistedStores, storeVersions);
    const declared = exception?.persistedState;
    if (exception === undefined || declared === undefined) {
      return { ...entry, message: `${entry.message} Exception is missing persistedState. ${remediation}` };
    }
    const refs = "store" in declared ? [declared] : declared;
    // One entry may span surfaces; a ref is relevant when any listed surface persists that store.
    const coveredStores = new Set(
      exception.locations.flatMap((location) => [
        ...(options.persistedStoresBySurface?.get(location.surface) ?? []),
      ]),
    );
    if (
      refs.some((ref) => !coveredStores.has(ref.store)) ||
      [...persistedStores].some((store) => !refs.some((ref) => ref.store === store))
    ) {
      return {
        ...entry,
        message: `${entry.message} Exception persistedState must cover every store for this surface. ${remediation}`,
      };
    }
    for (const ref of refs) {
      const currentVersion = storeVersions[ref.store];
      if (widening && currentVersion === undefined) {
        return {
          ...entry,
          message: `${entry.message} Determine the current version of ${ref.store} before accepting the exception. ${remediation}`,
        };
      }
      if (currentVersion === undefined || ref.version !== currentVersion) {
        return {
          ...entry,
          message: `${entry.message} Exception persistedState.version ${ref.version} does not match current ${ref.store} version ${currentVersion}. ${remediation}`,
        };
      }
      const baseVersion = options.baseStoreVersions?.[ref.store];
      const versionAdvanced = baseVersion === undefined || currentVersion > baseVersion;
      if (!versionAdvanced) {
        return {
          ...entry,
          message: `${entry.message} ${ref.store} version ${currentVersion} has not advanced from baseline ${baseVersion}. ${remediation}`,
        };
      }
    }
    return { ...entry, accepted: true, justification: exception.justification };
  });
};
