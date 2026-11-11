/**
 * The `# lando-lint: expect-invalid <reason>` marker a guide fixture Landofile carries on line 1
 * when it is deliberately invalid authoring input. lint:guides holds every marked fixture to
 * failing native authoring decode and every unmarked one to passing it.
 */
const MARKER = /^\s*# lando-lint: expect-invalid\s+(.+)$/;

export interface ExpectInvalidMarker {
  readonly line: number;
  readonly reason: string;
}

/** Every marker line, wherever it sits; lint:guides reports one that is not on line 1. */
export const expectInvalidMarkers = (content: string): ReadonlyArray<ExpectInvalidMarker> =>
  content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const reason = MARKER.exec(line)?.[1]?.trim();
      return reason === undefined ? [] : [{ line: index + 1, reason }];
    });

/** The reason from the line-1 marker, or undefined when the fixture claims to be valid input. */
export const expectInvalidReason = (content: string): string | undefined =>
  expectInvalidMarkers(content).find(({ line }) => line === 1)?.reason;
