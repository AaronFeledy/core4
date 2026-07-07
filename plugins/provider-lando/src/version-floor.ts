export interface PodmanVersionNumbers {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_NUMBERS_PATTERN = /(\d+)\.(\d+)\.(\d+)/u;

/**
 * Extracts the numeric `major.minor.patch` triple from a version string.
 * Pre-release and build suffixes (`6.1.0-rc1`, `6.0.2+build.5`) are ignored.
 */
export const parsePodmanVersionNumbers = (version: string): PodmanVersionNumbers | undefined => {
  const match = VERSION_NUMBERS_PATTERN.exec(version);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/**
 * Numeric `major.minor.patch` floor comparison shared by the Podman-backed
 * providers. An observed version that cannot be parsed fails closed.
 */
export const podmanVersionMeetsFloor = (observed: string, floor: string): boolean => {
  const observedNumbers = parsePodmanVersionNumbers(observed);
  const floorNumbers = parsePodmanVersionNumbers(floor);
  if (observedNumbers === undefined || floorNumbers === undefined) return false;
  if (observedNumbers.major !== floorNumbers.major) return observedNumbers.major > floorNumbers.major;
  if (observedNumbers.minor !== floorNumbers.minor) return observedNumbers.minor > floorNumbers.minor;
  return observedNumbers.patch >= floorNumbers.patch;
};
