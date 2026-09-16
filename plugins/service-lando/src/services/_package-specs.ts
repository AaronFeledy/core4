/**
 * Shared normalization for the package maps catalog services accept
 * (`node.globals` and the PHP `composer.packages` object form).
 *
 * Every entry is validated before it can reach a build command, and the
 * accepted character sets exclude quoting, substitution, and expression
 * characters, so neither a shell injection nor an unresolved `${secret:…}`
 * reference can reach a build step command or its build-key identity.
 */

/** An ordered `[name, version]` pair after normalization. */
export type PackageEntry = readonly [name: string, version: string];

const NPM_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_NAME_MAX_LENGTH = 214;
const NPM_VERSION_PATTERN = /^[A-Za-z0-9.^~<>=*|+ -]+$/;

// Composer's own package-name grammar.
const COMPOSER_NAME_PATTERN = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]|-{1,2})?[a-z0-9]+)*$/;
const COMPOSER_CONSTRAINT_PATTERN = /^[A-Za-z0-9.^~<>=*|,+@ -]+$/;

const VERSION_MAX_LENGTH = 128;

const isStringRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sortedEntries = (value: Readonly<Record<string, unknown>>): ReadonlyArray<[string, unknown]> =>
  Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

/**
 * Quote a validated token for a POSIX shell command. The validators above
 * already refuse single quotes, so this is a guard, not an escaper.
 */
export const shellSingleQuote = (token: string): string => {
  if (token.includes("'")) {
    throw new Error(`Value ${JSON.stringify(token)} cannot be quoted safely for a build command.`);
  }
  return `'${token}'`;
};

const assertVersion = (
  kind: "npm version specifier" | "Composer version constraint",
  pattern: RegExp,
  remediation: string,
  name: string,
  value: unknown,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > VERSION_MAX_LENGTH ||
    !pattern.test(value)
  ) {
    throw new Error(`Unsupported ${kind} ${JSON.stringify(value)} for "${name}". ${remediation}`);
  }
  return value;
};

/**
 * Normalize `services.<name>.globals` into sorted, validated npm entries.
 * Authoring order never reaches the build step, so reordering the map cannot
 * invalidate a built image.
 */
export const normalizeNpmGlobals = (value: unknown): ReadonlyArray<PackageEntry> => {
  if (value === undefined) return [];
  if (!isStringRecord(value)) {
    throw new Error(
      `Unsupported npm globals ${JSON.stringify(value)}. Set globals to a map of package name to version specifier, for example globals: { yarn: "1.22.4" }.`,
    );
  }
  return sortedEntries(value).map(([name, version]) => {
    if (name.length === 0 || name.length > NPM_NAME_MAX_LENGTH || !NPM_NAME_PATTERN.test(name)) {
      throw new Error(
        `Unsupported npm package "${name}". Use a published package name such as yarn or @angular/cli.`,
      );
    }
    return [
      name,
      assertVersion(
        "npm version specifier",
        NPM_VERSION_PATTERN,
        'Use a version, range, or dist-tag such as "1.22.4", "^17.0.0", or "latest".',
        name,
        version,
      ),
    ] as const;
  });
};

/**
 * Normalize `services.<name>.composer.packages` into sorted, validated
 * Composer entries.
 */
export const normalizeComposerPackages = (value: unknown): ReadonlyArray<PackageEntry> => {
  if (value === undefined) return [];
  if (!isStringRecord(value)) {
    throw new Error(
      `Unsupported Composer packages ${JSON.stringify(value)}. Set composer.packages to a map of package name to version constraint, for example { "drush/drush": "^13.0" }.`,
    );
  }
  return sortedEntries(value).map(([name, constraint]) => {
    if (!COMPOSER_NAME_PATTERN.test(name)) {
      throw new Error(
        `Unsupported Composer package "${name}". Use a lowercase vendor/name package such as drush/drush.`,
      );
    }
    return [
      name,
      assertVersion(
        "Composer version constraint",
        COMPOSER_CONSTRAINT_PATTERN,
        'Use a Composer constraint such as "^13.0", "13.0.0", or ">=1.0,<2.0".',
        name,
        constraint,
      ),
    ] as const;
  });
};
