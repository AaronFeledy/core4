export const MINIMUM_PODMAN_VERSION = "6.0.0";

export interface PodmanVersionNumbers {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_NUMBERS_PATTERN = /(\d+)\.(\d+)\.(\d+)/u;

export const parsePodmanVersionNumbers = (version: string): PodmanVersionNumbers | undefined => {
  const match = VERSION_NUMBERS_PATTERN.exec(version);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

export const podmanVersionMeetsFloor = (observed: string, floor: string): boolean => {
  const observedNumbers = parsePodmanVersionNumbers(observed);
  const floorNumbers = parsePodmanVersionNumbers(floor);
  if (observedNumbers === undefined || floorNumbers === undefined) return false;
  if (observedNumbers.major !== floorNumbers.major) return observedNumbers.major > floorNumbers.major;
  if (observedNumbers.minor !== floorNumbers.minor) return observedNumbers.minor > floorNumbers.minor;
  return observedNumbers.patch >= floorNumbers.patch;
};
