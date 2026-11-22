export const sanitizeStateWriter = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\x20-\x7E]{1,64}$/u.test(value) && value.trim() === value
    ? value
    : undefined;

export const newerStateRemediation = (input: {
  readonly path: string;
  readonly storedVersion: number;
  readonly supportedVersion: number;
  readonly writtenBy?: string | undefined;
  readonly reader?: string | undefined;
}): string => {
  const { path, storedVersion, supportedVersion } = input;
  const writer = sanitizeStateWriter(input.writtenBy);
  const reader = sanitizeStateWriter(input.reader);
  return writer !== undefined &&
    writer !== "0.0.0" &&
    reader !== undefined &&
    reader !== "0.0.0" &&
    writer !== reader
    ? `Lando ${writer} wrote ${path} (format ${storedVersion}; this Lando ${reader} supports ${supportedVersion}). Leave the file in place and run Lando ${writer} or newer (\`lando update\` upgrades an installed Lando).`
    : `A newer Lando wrote ${path} (format ${storedVersion}; this build supports ${supportedVersion}). Leave the file in place and run the build that wrote it, or a newer Lando${reader === undefined || reader === "0.0.0" ? "" : " (`lando update` upgrades an installed Lando)"}.`;
};
