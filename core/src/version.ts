import corePackage from "../package.json";

// `bun build --define=__LANDO_CORE_VERSION__=...` substitutes this token in compiled
// artifacts; undeclared in source, so the workspace package version is used.
declare const __LANDO_CORE_VERSION__: string | undefined;

const stampedVersion: string | undefined =
  typeof __LANDO_CORE_VERSION__ === "string" && __LANDO_CORE_VERSION__.length > 0
    ? __LANDO_CORE_VERSION__
    : undefined;

export const CORE_VERSION: string = stampedVersion ?? corePackage.version;

export const renderMetaVersion = (version: {
  readonly core: string;
  readonly bun: string;
  readonly platform: string;
}): string => `@lando/core ${version.core} (bun ${version.bun} on ${version.platform})`;
