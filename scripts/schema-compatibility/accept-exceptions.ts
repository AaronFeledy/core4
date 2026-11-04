import type { CompatibilityException, CompatibilityFinding, PersistedStoreId } from "./model.ts";
import { persistedMigrationRemediation } from "./persisted.ts";

export interface AcceptCompatibilityOptions {
  readonly persistedStoresBySurface?: ReadonlyMap<string, ReadonlySet<PersistedStoreId>>;
  readonly storeVersions?: Readonly<Record<PersistedStoreId, number>>;
  readonly baseStoreVersions?: Readonly<Partial<Record<PersistedStoreId, number>>>;
}

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
    const exception = exceptions.find(
      (candidate) =>
        candidate.surface === surface &&
        candidate.changeKind === entry.changeKind &&
        candidate.path === entry.path,
    );
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
    if (
      refs.some((ref) => !persistedStores.has(ref.store)) ||
      [...persistedStores].some((store) => !refs.some((ref) => ref.store === store))
    ) {
      return {
        ...entry,
        message: `${entry.message} Exception persistedState must cover every store for this surface. ${remediation}`,
      };
    }
    for (const ref of refs) {
      const currentVersion = storeVersions[ref.store];
      if (ref.version !== currentVersion) {
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
