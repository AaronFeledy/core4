import corePackage from "../package.json";

// `bun build --define=__LANDO_CORE_VERSION__='"x.y.z"'` replaces this token in
// compiled/bundled artifacts (the release pipeline stamps LANDO_RELEASE_VERSION
// through it). From source the token is undeclared, so `typeof` is "undefined"
// and the workspace package version is used.
declare const __LANDO_CORE_VERSION__: string | undefined;

const stampedVersion: string | undefined =
  typeof __LANDO_CORE_VERSION__ === "string" && __LANDO_CORE_VERSION__.length > 0
    ? __LANDO_CORE_VERSION__
    : undefined;

export const CORE_VERSION: string = stampedVersion ?? corePackage.version;
