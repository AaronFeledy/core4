/**
 * Corepack installation and launcher publication for a selected Node package
 * manager. The install is private to the image: no global bin links are
 * created, and only the selected manager's aliases are published.
 */

import { shellSingleQuote } from "./_package-specs.ts";
import {
  COREPACK_HOME,
  COREPACK_PREFIX,
  type NodePackageManagerConfig,
  packageManagerSpec,
} from "./node-package-manager.ts";

export const packageManagerBuildKeyInputs = (
  selection: NodePackageManagerConfig,
): Readonly<Record<string, unknown>> => ({
  packageManager: {
    name: selection.name,
    version: selection.version,
    ...(selection.integrity === undefined ? {} : { integrity: selection.integrity }),
  },
  corepack: { version: selection.corepack.version, sha256: selection.corepack.sha256 },
  launcher: selection.launcher,
});

interface PublishedLauncher {
  readonly binary: string;
  readonly request: string;
  readonly yarnPathIgnore: boolean;
}

const publishedLaunchers = (selection: NodePackageManagerConfig): ReadonlyArray<PublishedLauncher> => {
  const spec = packageManagerSpec(selection);
  return selection.name === "yarn"
    ? [
        { binary: "yarn", request: spec, yarnPathIgnore: true },
        { binary: "yarnpkg", request: spec, yarnPathIgnore: true },
      ]
    : [
        { binary: "pnpm", request: spec, yarnPathIgnore: false },
        {
          binary: "pnpx",
          request: packageManagerSpec(selection, "pnpx"),
          yarnPathIgnore: false,
        },
      ];
};

const launcherScript = (launcher: PublishedLauncher): ReadonlyArray<string> => [
  "#!/bin/sh",
  `export COREPACK_HOME=${COREPACK_HOME}`,
  "export COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_ENABLE_NETWORK=0 COREPACK_DEFAULT_TO_LATEST=0",
  "export COREPACK_ENV_FILE=0 COREPACK_ENABLE_AUTO_PIN=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
  ...(launcher.yarnPathIgnore ? ["export YARN_IGNORE_PATH=1"] : []),
  `exec /usr/local/bin/node ${COREPACK_PREFIX}/node_modules/corepack/dist/corepack.js "${launcher.request}" "$@"`,
];

const publishLauncher = (launcher: PublishedLauncher): string => {
  const target = `/usr/local/bin/${launcher.binary}`;
  return [
    `rm -f ${shellSingleQuote(target)}`,
    `printf '%s\\n' ${launcherScript(launcher).map(shellSingleQuote).join(" ")} > ${shellSingleQuote(target)}`,
    `chmod 0755 ${shellSingleQuote(target)}`,
  ].join(" && ");
};

/**
 * One artifact-phase command. It fetches Corepack with the image's npm (so the
 * registry, proxy, and CA settings configured for npm apply), verifies the
 * pinned tarball digest, installs it privately without touching global bin
 * links, seeds a fresh cache, and publishes launchers for the selected manager
 * and its aliases only.
 */
export const packageManagerBuildStepCommand = (selection: NodePackageManagerConfig): string => {
  const tarball = `corepack-${selection.corepack.version}.tgz`;
  const corepackEntry = `${COREPACK_PREFIX}/node_modules/corepack/dist/corepack.js`;
  const primaryLauncher = selection.name === "yarn" ? "yarn" : "pnpm";
  return [
    "set -eux",
    `rm -rf ${shellSingleQuote(COREPACK_PREFIX)} ${shellSingleQuote(COREPACK_HOME)}`,
    `mkdir -p ${shellSingleQuote(COREPACK_PREFIX)} ${shellSingleQuote(COREPACK_HOME)}`,
    'PACK_DIR="$(mktemp -d)"',
    'cd "$PACK_DIR"',
    `npm pack corepack@${selection.corepack.version}`,
    `printf '%s  %s\\n' ${shellSingleQuote(selection.corepack.sha256)} ${shellSingleQuote(tarball)} | sha256sum -c -`,
    `npm install --prefix ${shellSingleQuote(COREPACK_PREFIX)} --no-fund --no-audit ${shellSingleQuote(`./${tarball}`)}`,
    `COREPACK_HOME=${shellSingleQuote(COREPACK_HOME)} node ${shellSingleQuote(corepackEntry)} install -g ${shellSingleQuote(packageManagerSpec(selection))}`,
    ...publishedLaunchers(selection).map(publishLauncher),
    `chmod -R a+rX ${shellSingleQuote(COREPACK_PREFIX)} ${shellSingleQuote(COREPACK_HOME)}`,
    "cd /",
    `"/usr/local/bin/${primaryLauncher}" --version`,
    'rm -rf "$PACK_DIR"',
  ].join(" && ");
};
