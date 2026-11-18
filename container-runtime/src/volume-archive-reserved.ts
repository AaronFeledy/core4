/**
 * Root entries Lando reserves inside every managed volume: export excludes them
 * and import never publishes them.
 */

export const VOLUME_WITNESS_FILE = ".lando-volume-witness.json";
export const VOLUME_WITNESS_STAGE_PREFIX = ".lando-witness-stage-";
/** Staged import directories. */
export const VOLUME_IMPORT_PREFIX = ".lando-import-";
/** Directories holding a volume's pre-publication contents. */
export const VOLUME_REPLACED_PREFIX = ".lando-replaced-";
/** Marker recording that evacuation finished and installation started. */
export const VOLUME_INSTALLING_PREFIX = ".lando-installing-";

const RESERVED_PREFIXES: ReadonlyArray<string> = [
  VOLUME_WITNESS_STAGE_PREFIX,
  VOLUME_IMPORT_PREFIX,
  VOLUME_REPLACED_PREFIX,
  VOLUME_INSTALLING_PREFIX,
];

/** True when a root entry name belongs to Lando, never to authored volume data. */
export const isReservedVolumeEntry = (name: string): boolean =>
  name === VOLUME_WITNESS_FILE || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Every reserved root name; entries ending in `-` are prefixes. */
export const reservedVolumeEntries: ReadonlyArray<string> = [VOLUME_WITNESS_FILE, ...RESERVED_PREFIXES];
