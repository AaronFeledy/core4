import enginePackage from "@lando/engine/package.json";

// `bun build --define=__LANDO_CORE_VERSION__=...` substitutes this token in compiled
// artifacts; undeclared in source, so the workspace package version is used.
declare const __LANDO_CORE_VERSION__: string | undefined;

export const CORE_VERSION: string =
  typeof __LANDO_CORE_VERSION__ === "string" && __LANDO_CORE_VERSION__.length > 0
    ? __LANDO_CORE_VERSION__
    : enginePackage.version;

export const renderMetaVersion = (version: {
  readonly core: string;
  readonly bun: string;
  readonly platform: string;
}): string => `@lando/core ${version.core} (bun ${version.bun} on ${version.platform})`;
