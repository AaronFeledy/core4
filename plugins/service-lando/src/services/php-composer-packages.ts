import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import { type PackageEntry, normalizeComposerPackages, shellSingleQuote } from "./_package-specs.ts";
import type { PhpComposerRelease } from "./php-prerequisites.ts";

export const PHP_COMPOSER_PACKAGES_STEP_ID = "service-lando.php:composer-packages" as const;

/**
 * A world-readable Composer home so global tools installed as root stay
 * usable by a non-root service user; `COMPOSER_BIN_DIR` puts the generated
 * binary proxies straight onto the image's default PATH.
 */
const COMPOSER_HOME = "/usr/local/composer";
const COMPOSER_BIN_DIR = "/usr/local/bin";

/**
 * Resolve the global Composer packages authored on `composer.packages`.
 * String and `false` composer values carry no packages.
 */
export const resolvePhpComposerPackages = (value: unknown): ReadonlyArray<PackageEntry> => {
  if (value === undefined || value === false || typeof value === "string") return [];
  if (typeof value !== "object" || Array.isArray(value)) return [];
  return normalizeComposerPackages((value as { readonly packages?: unknown }).packages);
};

export const composerPackagesCommandFor = (entries: ReadonlyArray<PackageEntry>): string =>
  [
    "set -eux",
    [
      `COMPOSER_HOME=${COMPOSER_HOME}`,
      `COMPOSER_BIN_DIR=${COMPOSER_BIN_DIR}`,
      "COMPOSER_ALLOW_SUPERUSER=1",
      "COMPOSER_NO_INTERACTION=1",
      "composer global require --no-progress",
      ...entries.map(([name, constraint]) => shellSingleQuote(`${name}:${constraint}`)),
    ].join(" "),
    `chmod -R a+rX ${COMPOSER_HOME}`,
  ].join(" && ");

/**
 * Build the global Composer package install step, or `undefined` when no
 * packages were authored. `dependsOnComposerStep` is false when a custom image
 * supplies its own Composer and the Lando-managed install is skipped.
 */
export const phpComposerPackagesBuildStep = (
  release: PhpComposerRelease | false,
  entries: ReadonlyArray<PackageEntry>,
  options: { readonly dependsOnComposerStep: boolean; readonly composerStepId: string },
): ServiceBuildStepIntent | undefined => {
  if (entries.length === 0) return undefined;
  return {
    id: PHP_COMPOSER_PACKAGES_STEP_ID,
    phase: "build",
    command: composerPackagesCommandFor(entries),
    user: "root",
    ...(options.dependsOnComposerStep ? { dependsOn: [options.composerStepId] } : {}),
    buildKeyInputs: {
      ...(release === false ? {} : { composer: release }),
      packages: entries,
    },
  };
};
