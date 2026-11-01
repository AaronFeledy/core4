import type { ServiceShutdownObservation } from "@lando/sdk/schema";

/**
 * Merge provider-contributed observation arrays in action order.
 * Omits the field when no source supplied one; never invents ownership-only facts.
 * Later absence placeholders cannot obscure facts captured before removal.
 */
export const mergeShutdownObservations = (
  ...sources: ReadonlyArray<readonly ServiceShutdownObservation[] | undefined>
): readonly ServiceShutdownObservation[] | undefined => {
  let present = false;
  const out: ServiceShutdownObservation[] = [];
  for (const source of sources) {
    if (source === undefined) continue;
    present = true;
    for (const observation of source) {
      if (
        observation.status === "unknown" &&
        observation.reason === "container-absent" &&
        out.some(
          (earlier) =>
            !(earlier.status === "unknown" && earlier.reason === "container-absent") &&
            earlier.appId === observation.appId &&
            earlier.providerId === observation.providerId &&
            earlier.service === observation.service &&
            (observation.containerId === undefined || earlier.containerId === observation.containerId),
        )
      )
        continue;
      out.push(observation);
    }
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
