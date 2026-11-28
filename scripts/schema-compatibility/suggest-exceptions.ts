import { type AcceptCompatibilityOptions, findCompatibilityException } from "./accept-exceptions.ts";
import type {
  CompatibilityException,
  CompatibilityFinding,
  CompatibilityLocation,
  PersistedStateRef,
} from "./model.ts";

type LocatedFinding = CompatibilityFinding & { readonly surface: string };

const persistedStateFor = (
  locations: ReadonlyArray<CompatibilityLocation>,
  options: AcceptCompatibilityOptions,
): ReadonlyArray<PersistedStateRef> | undefined => {
  const stores = [
    ...new Set(
      locations.flatMap((location) => [...(options.persistedStoresBySurface?.get(location.surface) ?? [])]),
    ),
  ].sort();
  const refs = stores.flatMap((store) => {
    const version = options.storeVersions?.[store];
    return version === undefined ? [] : [{ store, version }];
  });
  return refs.length === 0 ? undefined : refs;
};

/**
 * Ready-to-paste entries for unreviewed findings, one per distinct change.
 * A change that already has an entry comes back as that entry with the new
 * locations merged in; a new change gets an empty justification, which the
 * exception parser rejects until a reviewer writes one.
 */
export const suggestCompatibilityExceptions = (
  findings: ReadonlyArray<LocatedFinding>,
  exceptions: ReadonlyArray<CompatibilityException>,
  options: AcceptCompatibilityOptions = {},
): ReadonlyArray<CompatibilityException> => {
  const pending = new Map<string, { changeKind: string; locations: CompatibilityLocation[] }>();
  for (const entry of findings) {
    if (entry.accepted || entry.verdict === "compatible" || entry.persistedWidening === "version-only")
      continue;
    if (findCompatibilityException(exceptions, entry.surface, entry) !== undefined) continue;
    const group = pending.get(entry.fingerprint) ?? { changeKind: entry.changeKind, locations: [] };
    group.locations.push({ surface: entry.surface, path: entry.path });
    pending.set(entry.fingerprint, group);
  }
  return [...pending].map(([fingerprint, group]) => {
    const existing = exceptions.find((candidate) => candidate.fingerprint === fingerprint);
    const locations = [...(existing?.locations ?? []), ...group.locations];
    const persistedState = persistedStateFor(locations, options) ?? existing?.persistedState;
    return {
      fingerprint,
      changeKind: group.changeKind,
      locations,
      justification: existing?.justification ?? "",
      ...(persistedState === undefined ? {} : { persistedState }),
    };
  });
};
