const PHP_MAJOR_MINOR = /^(\d+)\.(\d+)$/;
const COMPOSER_PIN_277 = "2.7.7";
const PHP_COMPOSER_MIN_INCOMPATIBLE = "8.5";

export const phpComposerIncompatibleRemediation = (phpVersion: string): string =>
  `Composer "2.7.7" cannot run on PHP ${phpVersion}. Set composer: "2" (2.10.2) or a newer exact pin.`;

const parseMajorMinor = (version: string): readonly [number, number] | undefined => {
  const match = PHP_MAJOR_MINOR.exec(version);
  if (match === null) return undefined;
  const major = match[1];
  const minor = match[2];
  if (major === undefined || minor === undefined) return undefined;
  return [Number(major), Number(minor)];
};

export const phpVersionAtLeast = (phpVersion: string, minimum: string): boolean => {
  const current = parseMajorMinor(phpVersion);
  const floor = parseMajorMinor(minimum);
  if (current === undefined || floor === undefined) return false;
  const [currentMajor, currentMinor] = current;
  const [floorMajor, floorMinor] = floor;
  return currentMajor > floorMajor || (currentMajor === floorMajor && currentMinor >= floorMinor);
};

const choiceIsComposer277 = (choice: unknown): boolean => {
  if (String(choice) === COMPOSER_PIN_277) return true;
  if (typeof choice !== "object" || choice === null || !("value" in choice)) return false;
  return choice.value === COMPOSER_PIN_277;
};

export const composerChoicesForPhp = <T>(phpVersion: string, choices: ReadonlyArray<T>): ReadonlyArray<T> => {
  if (!phpVersionAtLeast(phpVersion, PHP_COMPOSER_MIN_INCOMPATIBLE)) return choices;
  return choices.filter((choice) => !choiceIsComposer277(choice));
};
