import type { CompatibilityException, CompatibilityFinding, PersistedStoreId } from "./model.ts";
import { persistedMigrationRemediation } from "./persisted.ts";

export interface AcceptCompatibilityOptions {
  readonly persistedStoresBySurface?: ReadonlyMap<string, ReadonlySet<PersistedStoreId>>;
  readonly storeVersions?: Readonly<Partial<Record<PersistedStoreId, number>>>;
  readonly baseStoreVersions?: Readonly<Partial<Record<PersistedStoreId, number>>>;
}

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
  const storeVersions = options.storeVersions;
  return findings.map((entry) => {
    if (entry.verdict === "compatible") return entry;
    const exception = findCompatibilityException(exceptions, surface, entry);
    if (persistedStores === undefined || storeVersions === undefined) {
      return exception === undefined
        ? entry
        : { ...entry, accepted: true, justification: exception.justification };
    }
    const remediation = persistedMigrationRemediation(persistedStores, storeVersions);
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
      if (currentVersion === undefined || ref.version !== currentVersion) {
        return {
          ...entry,
          message: `${entry.message} Exception persistedState.version ${ref.version} does not match current ${ref.store} version ${currentVersion}. ${remediation}`,
        };
      }
      const baseVersion = options.baseStoreVersions?.[ref.store];
      if (baseVersion !== undefined && currentVersion <= baseVersion) {
        return {
          ...entry,
          message: `${entry.message} ${ref.store} version ${currentVersion} has not advanced from baseline ${baseVersion}. ${remediation}`,
        };
      }
    }
    return { ...entry, accepted: true, justification: exception.justification };
  });
};
