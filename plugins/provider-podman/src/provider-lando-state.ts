/**
 * Mirrors `@lando/provider-lando`'s `providerStatePath` on purpose for the
 * cross-plugin conflict probe. Keep this path in sync with that owner.
 */
export const providerLandoSetupStatePath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/provider-lando/setup-state.json`;
