import { expect, test } from "bun:test";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import { packageManagerConfigFor } from "../src/services/node-package-manager.ts";
import { packageManagerBuildStep } from "../src/services/node-package-manager-install.ts";

const legacyPnpm =
  "export npm_config_manage_package_manager_versions=false npm_config_package_manager_strict=false npm_config_package_manager_strict_version=false; ";

test.each([
  ["pnpm", "9.15.0", "pnpm", { pnpm: "bin/pnpm.cjs", pnpx: "bin/pnpx.cjs" }, legacyPnpm],
  ["pnpm", "10.0.0", "pnpm", { pnpm: "bin/pnpm.cjs", pnpx: "bin/pnpx.cjs" }, legacyPnpm],
  [
    "pnpm",
    "11.0.0",
    "pnpm",
    { pnpm: "bin/pnpm.mjs", pnpx: "bin/pnpx.mjs" },
    "export pnpm_config_pm_on_fail=ignore; ",
  ],
  [
    "yarn",
    "1.22.22",
    "yarn",
    { yarn: "bin/yarn.js", yarnpkg: "bin/yarn.js" },
    "export YARN_IGNORE_PATH=1 SKIP_YARN_COREPACK_CHECK=1; ",
  ],
  [
    "yarn",
    "4.18.1",
    "@yarnpkg/cli-dist",
    { yarn: "bin/yarn.js", yarnpkg: "bin/yarn.js" },
    "export YARN_IGNORE_PATH=1; ",
  ],
] as const)("publishes direct launchers and smokes %s@%s", (name, version, distribution, bin, env) => {
  const { command } = packageManagerBuildStep(
    packageManagerConfigFor({ name, version, sourceField: "packageManager", sourcePath: "package.json" }),
  );
  if (!Array.isArray(command) || typeof command[2] !== "string" || typeof command[3] !== "string") {
    throw new TypeError("Expected an argv image command with a publication script and package root.");
  }
  const root = command[3];
  const writes = new Map<string, string>();
  const removed = new Set<string>();
  const smoke: unknown[] = [];
  const process = { argv: [command[0], ...command.slice(3)], exitCode: 0 };
  runInNewContext(command[2], {
    process,
    require: (id: string) => {
      switch (id) {
        case "node:path":
          return posix;
        case "node:fs":
          return {
            readFileSync: () => JSON.stringify({ name: distribution, version, bin }),
            realpathSync: (path: string) => path,
            statSync: () => ({ isFile: () => true }),
            rmSync: (path: string) => removed.add(path),
            writeFileSync: (
              path: string,
              text: string,
              options: { readonly flag: string; readonly mode: number },
            ) => {
              expect(removed.has(path)).toBe(true);
              expect(options).toEqual({ flag: "wx", mode: 0o755 });
              writes.set(path, text);
            },
          };
        case "node:child_process":
          return {
            spawnSync: (...args: unknown[]) => {
              smoke.push(args);
              return { status: 7 };
            },
          };
        default:
          throw new TypeError(`Unexpected publication dependency ${id}.`);
      }
    },
  });
  const berry =
    distribution === "@yarnpkg/cli-dist"
      ? `unset COREPACK_ROOT\nexport YARN_YARN_PATH='${root}/bin/yarn.js'\n`
      : "";
  expect(Object.fromEntries(writes)).toEqual(
    Object.fromEntries(
      Object.entries(bin).map(([alias, file]) => [
        `/usr/local/bin/${alias}`,
        `#!/bin/sh\n${env}${berry}exec /usr/local/bin/node '${root}/${file}' "$@"\n`,
      ]),
    ),
  );
  expect(smoke).toEqual([[`/usr/local/bin/${name}`, ["--version"], { cwd: "/", stdio: "inherit" }]]);
  expect(process.exitCode).toBe(7);
});
