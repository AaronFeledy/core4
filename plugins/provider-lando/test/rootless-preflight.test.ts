import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedRuntimeDirFsSeam } from "@lando/container-runtime/podman/managed-runtime-dir";
import { Effect } from "effect";

import {
  CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION,
  RootlessPrerequisiteError,
  type RootlessProbeResults,
  classifyRootlessFailure,
  hasCgroupsV2Delegation,
  hasPrivateRuntimeBase,
  makeSystemRootlessProbes,
} from "../src/rootless-preflight.ts";

const allSatisfied: RootlessProbeResults = {
  subidConfigured: true,
  subidRangeSufficient: true,
  subidRangesDisjoint: true,
  hasUidmapTools: true,
  cgroupsV2Delegated: true,
  hasXdgRuntimeDir: true,
};

const classify = (overrides: Partial<RootlessProbeResults>, host?: { readonly hasSystemd?: boolean }) =>
  classifyRootlessFailure({ ...allSatisfied, ...overrides }, undefined, host);

describe("rootless preflight", () => {
  test("classifyRootlessFailure flags missing subuid/subgid with usermod remediation", () => {
    const error = classify({ subidConfigured: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("subid");
    expect(error?.remediation).toContain("usermod");
    expect(error?.remediation).toContain("/etc/subuid");
  });

  test("flags missing newuidmap/newgidmap with uidmap install remediation", () => {
    const error = classify({ hasUidmapTools: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("uidmap-tools");
    expect(error?.remediation).toContain("uidmap");
  });

  test("flags a subordinate ID range that is too small", () => {
    const error = classify({ subidRangeSufficient: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("subid-range");
    expect(error?.remediation).toContain("--add-subuids");
    expect(error?.remediation).toContain("--add-subgids");
  });

  test("flags overlapping subordinate ID allocations", () => {
    const error = classify({ subidRangesDisjoint: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("subid-overlap");
    expect(error?.remediation).toContain("/etc/subuid");
    expect(error?.remediation).toContain("/etc/subgid");
  });

  test("flags missing cgroups v2 delegation", () => {
    const error = classify({ cgroupsV2Delegated: false }, { hasSystemd: true });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("cgroups-v2-delegation");
    expect(error?.remediation).toContain("Delegate");
    expect(error?.remediation).toContain("lando setup --provider=docker");
  });

  test("no-systemd / tini host cgroup rem names missing systemd and Docker fallback", () => {
    const error = classify({ cgroupsV2Delegated: false }, { hasSystemd: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("cgroups-v2-delegation");
    expect(error?.remediation).toBe(CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION);
    expect(error?.remediation).toMatch(/not running systemd/i);
    expect(error?.remediation).toContain("lando setup --provider=docker");
    expect(error?.remediation).not.toContain("systemctl daemon-reload");
  });

  test("flags missing private runtime dir base with reworded xdg-runtime-dir tag", () => {
    const error = classify({ hasXdgRuntimeDir: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("xdg-runtime-dir");
    expect(error?.message).toContain("private runtime directory base");
    expect(error?.remediation).toContain("/run/user/");
    expect(error?.remediation).toContain("XDG_RUNTIME_DIR");
    expect(error?.remediation).toContain("0700");
  });

  test("returns undefined when all prerequisites satisfied", () => {
    expect(classifyRootlessFailure(allSatisfied)).toBeUndefined();
  });

  test("prioritizes subid when multiple prerequisites are missing", () => {
    const error = classify({
      subidConfigured: false,
      subidRangeSufficient: false,
      subidRangesDisjoint: false,
      hasUidmapTools: false,
    });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("subid");
  });

  test("prioritizes range size before overlap and uidmap tools", () => {
    const error = classify({
      subidRangeSufficient: false,
      subidRangesDisjoint: false,
      hasUidmapTools: false,
    });

    expect(error?.prerequisite).toBe("subid-range");
  });

  test("prioritizes overlap before uidmap tools", () => {
    const error = classify({ subidRangesDisjoint: false, hasUidmapTools: false });

    expect(error?.prerequisite).toBe("subid-overlap");
  });

  test("RootlessPrerequisiteError remains a tagged provider error", () => {
    const error = new RootlessPrerequisiteError("subid");

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error._tag).toEqual(expect.any(String));
    expect(error._tag.length).toBeGreaterThan(0);
  });

  test("cgroups v2 delegation is unused when the host has no systemd user.slice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-cgroups-"));
    try {
      await writeFile(join(dir, "cgroup.controllers"), "cpu memory pids\n");
      expect(hasCgroupsV2Delegation(dir, "1000")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cgroups v2 delegation requires controllers on the user service cgroup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-cgroups-"));
    try {
      const userServiceDir = join(dir, "user.slice", "user-1000.slice", "user@1000.service");
      await mkdir(userServiceDir, { recursive: true });
      expect(hasCgroupsV2Delegation(dir, "1000")).toBe(false);

      await writeFile(join(userServiceDir, "cgroup.controllers"), "cpu memory pids\n");

      expect(hasCgroupsV2Delegation(dir, "1000")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const seamStat = (
  path: string,
  table: Record<string, { isDirectory: boolean; uid: number; mode: number }>,
) => {
  const info = table[path];
  if (info === undefined) return Effect.fail(new Error(`missing:${path}`));
  return Effect.succeed(info);
};

const fsSeam = (
  table: Record<string, { isDirectory: boolean; uid: number; mode: number }>,
  realpath: (path: string) => string = (path) => path,
): ManagedRuntimeDirFsSeam => ({
  realpath: (path) =>
    Effect.try({
      try: () => realpath(path),
      catch: (cause) => cause,
    }),
  stat: (path) => seamStat(path, table),
  mkdir: () => Effect.void,
  chmod: () => Effect.void,
});

describe("private runtime base", () => {
  test("prefers owner-only /run/user/<uid> over env XDG_RUNTIME_DIR", () => {
    const available = hasPrivateRuntimeBase(
      { XDG_RUNTIME_DIR: "/tmp/xdg-fallback" },
      {
        getuid: () => 1000,
        runtimeDirForProbe: "/data/runtime",
        fs: fsSeam({
          "/run/user/1000": { isDirectory: true, uid: 1000, mode: 0o40700 },
          "/tmp/xdg-fallback": { isDirectory: true, uid: 1000, mode: 0o40700 },
        }),
      },
    );
    expect(available).toBe(true);
  });

  test("falls back to owner-only env XDG_RUNTIME_DIR when /run/user/<uid> is missing", () => {
    const available = hasPrivateRuntimeBase(
      { XDG_RUNTIME_DIR: "/tmp/xdg-ok" },
      {
        getuid: () => 1000,
        runtimeDirForProbe: "/data/runtime",
        fs: fsSeam({
          "/tmp/xdg-ok": { isDirectory: true, uid: 1000, mode: 0o40700 },
        }),
      },
    );
    expect(available).toBe(true);
  });

  test("rejects group-writable or foreign-owned bases", () => {
    expect(
      hasPrivateRuntimeBase(
        { XDG_RUNTIME_DIR: "/tmp/xdg-group" },
        {
          getuid: () => 1000,
          runtimeDirForProbe: "/data/runtime",
          fs: fsSeam({
            "/run/user/1000": { isDirectory: true, uid: 1000, mode: 0o40770 },
            "/tmp/xdg-group": { isDirectory: true, uid: 1000, mode: 0o40770 },
          }),
        },
      ),
    ).toBe(false);

    expect(
      hasPrivateRuntimeBase(
        { XDG_RUNTIME_DIR: "/tmp/xdg-foreign" },
        {
          getuid: () => 1000,
          runtimeDirForProbe: "/data/runtime",
          fs: fsSeam({
            "/run/user/1000": { isDirectory: true, uid: 0, mode: 0o40700 },
            "/tmp/xdg-foreign": { isDirectory: true, uid: 0, mode: 0o40700 },
          }),
        },
      ),
    ).toBe(false);
  });

  test("makeSystemRootlessProbes reports hasXdgRuntimeDir from base availability", () => {
    const missing = makeSystemRootlessProbes(
      { USER: "nobody", PATH: "" },
      {
        getuid: () => 1000,
        runtimeDirForProbe: "/data/runtime",
        fs: fsSeam({}),
      },
    ).probe();
    expect(missing.hasXdgRuntimeDir).toBe(false);

    const present = makeSystemRootlessProbes(
      { USER: "nobody", PATH: "", XDG_RUNTIME_DIR: "/tmp/xdg-ok" },
      {
        getuid: () => 1000,
        runtimeDirForProbe: "/data/runtime",
        fs: fsSeam({
          "/tmp/xdg-ok": { isDirectory: true, uid: 1000, mode: 0o40700 },
        }),
      },
    ).probe();
    expect(present.hasXdgRuntimeDir).toBe(true);
  });
});
