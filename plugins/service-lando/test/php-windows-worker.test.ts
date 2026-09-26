import { existsSync, readFileSync, rmSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { windowsBindWorkerIdentity } from "../src/services/php-via.ts";

interface RunOptions {
  readonly os: string;
  readonly owner: string;
  readonly explicitApache?: boolean;
  readonly uidOwner?: string;
  readonly gidOwner?: string;
}

const runIdentity = (options: RunOptions) => {
  const fragment = windowsBindWorkerIdentity("/app", options.explicitApache ?? false).join("\n");
  const script = [
    "set -eu",
    'calls_file="$1"',
    `stat() { printf '%s\\n' ${JSON.stringify(options.owner)}; }`,
    `getent() { if test "$1" = passwd && test -n ${JSON.stringify(options.uidOwner ?? "")}; then printf '%s:x:%s:1::/tmp:/bin/false\\n' ${JSON.stringify(options.uidOwner ?? "")} "$2"; elif test "$1" = group && test -n ${JSON.stringify(options.gidOwner ?? "")}; then printf '%s:x:%s:\\n' ${JSON.stringify(options.gidOwner ?? "")} "$2"; fi; }`,
    'id() { printf "33\\n"; }',
    'groupmod() { printf "groupmod %s\\n" "$*" >> "$calls_file"; }',
    'usermod() { printf "usermod %s\\n" "$*" >> "$calls_file"; }',
    'fake_server() { printf "server\\n" >> "$calls_file"; }',
    fragment,
    "fake_server",
  ].join("\n");
  const callsFile = `/tmp/lando-php-worker-${crypto.randomUUID()}`;
  const result = Bun.spawnSync(["sh", "-c", script, "lando-worker-test", callsFile], {
    env: {
      ...process.env,
      LANDO_HOST_OS: options.os,
      LANDO_PROJECT_MOUNT: "/app",
      ...(options.explicitApache ? { APACHE_RUN_USER: "custom", APACHE_RUN_GROUP: "custom" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "";
  rmSync(callsFile, { force: true });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    calls: calls.trim().split("\n").filter(Boolean),
  };
};

describe("Windows PHP worker identity startup", () => {
  test("remaps www-data before starting the server for a positive mount owner", () => {
    expect(runIdentity({ os: "win32", owner: "1000:1000" })).toEqual({
      exitCode: 0,
      stderr: "",
      calls: ["groupmod --gid 1000 www-data", "usermod --uid 1000 --gid 1000 www-data", "server"],
    });
  });

  test.each(["linux", "darwin"])("does not inspect or mutate accounts on %s", (os) => {
    const result = runIdentity({ os, owner: "invalid" });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual(["server"]);
  });

  test("preserves an explicit Apache worker identity", () => {
    const result = runIdentity({ os: "win32", owner: "invalid", explicitApache: true });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual(["server"]);
  });

  test("keeps root-owned Windows mounts on the existing worker identity", () => {
    const result = runIdentity({ os: "win32", owner: "0:0" });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual(["server"]);
  });

  test.each([
    { field: "uid", uidOwner: "other" },
    { field: "gid", gidOwner: "other" },
  ])("fails before mutation when the mount $field belongs to another account", (collision) => {
    const result = runIdentity({ os: "win32", owner: "1000:1000", ...collision });
    expect(result.exitCode).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("already owned by other");
  });

  test("fails malformed ownership before mutation", () => {
    const result = runIdentity({ os: "win32", owner: "unknown" });
    expect(result.exitCode).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("numeric uid:gid ownership");
  });
});
