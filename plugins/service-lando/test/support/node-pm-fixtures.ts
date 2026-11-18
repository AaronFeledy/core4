import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shellSingleQuote } from "../../src/services/_package-specs.ts";
import { runBuiltImage } from "./run-built-image.ts";

const MISSING_FIXTURE = "Missing mounted fixture" as const;

/**
 * Runs `command` offline with the fixture project bind-mounted read-only at
 * `/app`. The bind source must be visible to the container engine: a remote
 * engine (for example another WSL distribution) cannot see this host's temp
 * tree, so set LANDO_TEST_PROJECT_BIND_ROOT to a directory both sides share.
 */
export const runWithProject = async (input: {
  readonly socketPath: string;
  readonly image: string;
  readonly files: Readonly<Record<string, string>>;
  readonly command: string;
  readonly cwd?: string;
  readonly user?: string;
  readonly asRoot?: boolean;
}) => {
  const root = await mkdtemp(join(process.env.LANDO_TEST_PROJECT_BIND_ROOT ?? tmpdir(), "lando-node-pm-"));
  try {
    await chmod(root, 0o755);
    const checks = [];
    for (const [path, content] of Object.entries(input.files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o755 });
      await writeFile(file, content, { mode: 0o644 });
      const mounted = `/app/${path}`;
      checks.push(
        `test -f ${shellSingleQuote(mounted)} || { printf '%s\\n' ${shellSingleQuote(`${MISSING_FIXTURE}: ${mounted}`)} >&2; exit 1; }`,
      );
    }
    const bound = await runBuiltImage(input.socketPath, input.image, [], {
      script: ["set -e", ...checks, `cd ${shellSingleQuote(input.cwd ?? "/app")}`, input.command].join("\n"),
      offline: true,
      binds: [`${root}:/app:ro`],
      ...(input.user === undefined ? {} : { user: input.user }),
      ...(input.asRoot === true ? { asRoot: true } : {}),
    });
    if (`${bound.stdout}${bound.stderr}`.includes(MISSING_FIXTURE)) {
      throw new Error(
        `The container engine cannot see ${root}. Set LANDO_TEST_PROJECT_BIND_ROOT to a directory shared with the engine.`,
      );
    }
    return bound;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Image ref suffix for package-manager artifact builds in the live suite. */
export const NODE_PM_ARTIFACT_REF_SUFFIX = "-node-pm" as const;

/** Image ref suffix for the intentional integrity-mismatch build. */
export const NODE_PM_BAD_HASH_ARTIFACT_REF_SUFFIX = "-node-pm-bad-hash" as const;

/** Image ref prefix shared with `runBuiltImage` container names. */
export const BUILD_TEST_REF_PREFIX = "lando-build-test-" as const;

/**
 * Marker a vendored Yarn binary prints when selected. Live suites write a real
 * script into the project tree so a missing `YARN_IGNORE_PATH` would surface
 * this string instead of the provisioned release.
 */
export const VENDORED_YARN_MARKER = "vendored-yarn-path-selected" as const;

/** Minimal Node script that prints {@link VENDORED_YARN_MARKER} and exits 0. */
export const vendoredYarnScript = `#!/usr/bin/env node
console.log(${JSON.stringify(VENDORED_YARN_MARKER)});
` as const;

/** Yarn Berry config that points `yarnPath` at a real vendored script under `/app`. */
export const yarnBerryPathRc = (relativeScript = ".yarn/releases/yarn-vendored.cjs"): string =>
  `yarnPath: ${relativeScript}\n`;

/** Yarn classic `.yarnrc` that points `yarn-path` at a real vendored script under `/app`. */
export const yarnClassicPathRc = (relativeScript = ".yarn/releases/yarn-vendored.cjs"): string =>
  `yarn-path "${relativeScript}"\n`;

/**
 * Corepack 0.34.x message when `COREPACK_ENABLE_NETWORK=0` blocks acquisition.
 * Pinned against the private Corepack the node build installs (`node-corepack-pins.json`).
 */
export const COREPACK_NETWORK_DISABLED_PATTERN = /Network access disabled by the environment/;
