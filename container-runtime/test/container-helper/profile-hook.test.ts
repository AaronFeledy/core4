import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_HELPER_PROFILE_HOOK,
  CONTAINER_HELPER_PROFILE_HOOK_TARGET,
  CONTAINER_HELPER_PROFILE_STUB,
} from "../../src/container-helper.ts";

// The hook reads the shell's initial environment from /proc/$$/environ, so it only
// runs where Linux procfs exists. Its file path is fixed, so the unreadable-environ
// no-op has no seam here and is not exercised.
const procfs = process.platform === "linux" && existsSync("/proc/self/environ");

const dir = mkdtempSync(join(tmpdir(), "lando-profile-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const hook = join(dir, "hook.sh");
const reset = join(dir, "reset.sh");
const prepend = join(dir, "prepend.sh");
const stub = join(dir, "stub.sh");
writeFileSync(hook, CONTAINER_HELPER_PROFILE_HOOK);
// The real stub, pointed at this temp copy of the body instead of the helper mount.
writeFileSync(stub, CONTAINER_HELPER_PROFILE_STUB.replaceAll(CONTAINER_HELPER_PROFILE_HOOK_TARGET, hook));
// What Debian's /etc/profile does to PATH before it sources /etc/profile.d.
writeFileSync(reset, "PATH=/usr/local/sbin:/usr/bin:/bin\n");
writeFileSync(prepend, "PATH=/pre:$PATH\n");
const RESET = "/usr/local/sbin:/usr/bin:/bin";

const shells: ReadonlyArray<{ readonly name: string; readonly argv: ReadonlyArray<string> | undefined }> = [
  { name: "dash", argv: whichArgv("dash") },
  { name: "bash", argv: whichArgv("bash") },
  { name: "busybox ash", argv: whichArgv("busybox", "sh") },
];

function whichArgv(binary: string, ...rest: ReadonlyArray<string>): ReadonlyArray<string> | undefined {
  const path = Bun.which(binary);
  return path === null ? undefined : [path, ...rest];
}

/** Runs `set -u`, the reset profile, the hook, then `body`, under a child whose initial environment is exactly `env`. */
const login = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  body = "",
  profile = hook,
) => {
  const script = `set -u; . "$1"; . "$2"; ${body} printf '%s|%s' "$PATH" "\${__lando_soh+x}\${__lando_path+x}\${__lando_record+x}\${__lando_merged+x}\${__lando_rest+x}\${__lando_entry+x}"`;
  const child = Bun.spawnSync([...argv, "-c", script, "sh", reset, profile], { env: { ...env } });
  const [path, leaked] = child.stdout.toString().split("|");
  return { exitCode: child.exitCode, path, leaked };
};

const cases: ReadonlyArray<{
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly path: string;
}> = [
  {
    name: "restores the initial PATH, empty components included, then appends profile entries in order",
    env: { PATH: "/opt/go/bin::/usr/bin" },
    path: "/opt/go/bin::/usr/bin:/usr/local/sbin:/bin",
  },
  {
    name: "keeps glob characters literal",
    env: { PATH: "/a/*?[b:/bin" },
    path: "/a/*?[b:/bin:/usr/local/sbin:/usr/bin",
  },
  {
    name: "never reads PATH out of another variable's value",
    env: { X: "a\nPATH=/evil" },
    path: RESET,
  },
  {
    name: "does nothing when the initial PATH holds a newline",
    env: { PATH: "/a\n/b" },
    path: RESET,
  },
  {
    name: "does nothing when the initial PATH is empty",
    env: { PATH: "" },
    path: RESET,
  },
  {
    name: "leaves PATH alone without aborting when it is readonly",
    env: { PATH: "/opt/x" },
    body: `PATH=/usr/bin:/bin; readonly PATH; . "$2";`,
    path: "/usr/bin:/bin",
  },
  {
    name: "lets a later profile prepend",
    env: { PATH: "/opt/x" },
    body: `. "${prepend}";`,
    path: `/pre:/opt/x:${RESET}`,
  },
];

for (const shell of shells)
  describe(`login-profile hook under ${shell.name}`, () => {
    for (const { name, env, body, path } of cases)
      test.skipIf(!procfs || shell.argv === undefined)(name, () => {
        // Given a child shell whose initial environment is `env`, under `set -u`
        if (shell.argv === undefined) throw new TypeError(`${shell.name} is unavailable`);
        // When the distro profile resets PATH and the hook runs
        const result = login(shell.argv, env, body);
        // Then
        expect(result).toEqual({ exitCode: 0, path, leaked: "" });
      });
  });

for (const shell of shells)
  test.skipIf(!procfs || shell.argv === undefined)(
    `the profile stub sources the hook body under ${shell.name}`,
    () => {
      // Given the stub that is bound at /etc/profile.d, with the body it names present
      if (shell.argv === undefined) throw new TypeError(`${shell.name} is unavailable`);
      // When the distro profile resets PATH and the stub runs
      const result = login(shell.argv, { PATH: "/opt/go/bin:/usr/bin" }, "", stub);
      // Then
      expect(result).toEqual({ exitCode: 0, path: "/opt/go/bin:/usr/bin:/usr/local/sbin:/bin", leaked: "" });
    },
  );
