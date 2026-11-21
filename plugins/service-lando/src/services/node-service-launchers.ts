import type { ServiceLaunchers } from "@lando/sdk/services";

import type { NodePackageManagerName } from "./node-package-manager.ts";

/** Argv prefix that runs a local package bin through the selected manager. */
const nodeLocalPrefix = (manager: NodePackageManagerName | undefined): readonly [string, ...string[]] => {
  if (manager === "pnpm") return ["pnpm", "exec"];
  if (manager === "yarn") return ["yarn", "run"];
  // npm, Bun (unprovisioned), or no declaration: npm exec against node_modules/.bin.
  return ["npm", "exec", "--no", "--"];
};

const INSTALL_COMMANDS = {
  npm: "npm install --no-audit --no-fund",
  pnpm: "pnpm install",
  yarn: "yarn install",
} as const;

/**
 * Install with the selected manager, then `run` the package script that follows
 * the marker. npm needs `--` before script args so they are not npm's own flags.
 *
 * The manager runs the script through `sh -c`, and dash forwards no signal to
 * its child, so a stop would never reach the server. The script therefore runs
 * in its own session; this shell forwards stop signals to that whole process
 * group and exits only once every member is gone, so graceful shutdown finishes
 * before the container's init tears the container down.
 */
const nodeInstallRunPrefix = (
  manager: Exclude<NodePackageManagerName, "bun"> | undefined,
): readonly [string, ...string[]] => {
  const selected = manager ?? "npm";
  const run =
    selected === "npm"
      ? 'if [ "$#" -eq 0 ]; then setsid npm run "$script" <&0 & else setsid npm run "$script" -- "$@" <&0 & fi'
      : `setsid ${selected} run "$script" "$@" <&0 &`;
  return [
    "sh",
    "-c",
    [
      `${INSTALL_COMMANDS[selected]} || exit $?`,
      "script=$1",
      "shift",
      "child=",
      "signal=",
      // Before setsid runs in the child, its group does not exist yet; signal the pid.
      'forward() { signal=$1; [ -z "$child" ] || kill -s "$1" -- "-$child" 2>/dev/null || kill -s "$1" "$child" 2>/dev/null; }',
      "trap 'forward TERM' TERM",
      "trap 'forward INT' INT",
      "trap 'forward HUP' HUP",
      run,
      "child=$!",
      '[ -z "$signal" ] || forward "$signal"',
      'while :; do wait "$child"; status=$?; kill -0 "$child" 2>/dev/null || break; done',
      '[ -n "$signal" ] || kill -s TERM -- "-$child" 2>/dev/null',
      'while kill -s 0 -- "-$child" 2>/dev/null; do sleep 0.1; done',
      'exit "$status"',
    ].join("\n"),
    "node-install-run",
  ];
};

/**
 * Service-type launchers for Node.
 * - `:node-local` on every Node service (catalog or BYO; Bun falls back to npm exec).
 * - `:node-install-run` only for catalog-owned Node with npm, pnpm, Yarn, or no
 *   declaration (npm). Not for BYO images/builds and not for a Bun pin.
 */
export const nodeServiceLaunchers = (input: {
  readonly catalogOwned: boolean;
  readonly manager: NodePackageManagerName | undefined;
}): ServiceLaunchers => ({
  ":node-local": nodeLocalPrefix(input.manager),
  ...(input.catalogOwned && input.manager !== "bun"
    ? { ":node-install-run": nodeInstallRunPrefix(input.manager) }
    : {}),
});
