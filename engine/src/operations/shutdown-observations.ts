import type { ServiceShutdownObservation } from "@lando/sdk/schema";

/**
 * Concatenate provider-contributed observation arrays.
 * Omits the field when no source supplied one; never invents ownership-only facts.
 * Empty arrays and absent-container observations are preserved when a source contributed them.
 */
export const mergeShutdownObservations = (
  ...sources: ReadonlyArray<readonly ServiceShutdownObservation[] | undefined>
): readonly ServiceShutdownObservation[] | undefined => {
  let present = false;
  const out: ServiceShutdownObservation[] = [];
  for (const source of sources) {
    if (source === undefined) continue;
    present = true;
    out.push(...source);
  }
  return present ? out : undefined;
};

/** Attach `shutdownObservations` only when at least one source contributed an array. */
export const withShutdownObservations = <T extends object>(
  receipt: T,
  ...sources: ReadonlyArray<readonly ServiceShutdownObservation[] | undefined>
): T & { readonly shutdownObservations?: readonly ServiceShutdownObservation[] } => {
  const shutdownObservations = mergeShutdownObservations(...sources);
  return shutdownObservations === undefined ? receipt : { ...receipt, shutdownObservations };
};
