import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION,
  RootlessPrerequisiteError,
  type RootlessProbeResults,
  classifyRootlessFailure,
  hasCgroupsV2Delegation,
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

  test("flags missing XDG_RUNTIME_DIR", () => {
    const error = classify({ hasXdgRuntimeDir: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("xdg-runtime-dir");
    expect(error?.remediation).toContain("XDG_RUNTIME_DIR");
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
