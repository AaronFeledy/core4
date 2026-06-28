import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RootlessPrerequisiteError,
  type RootlessProbeResults,
  classifyRootlessFailure,
  hasCgroupsV2Delegation,
} from "../src/rootless-preflight.ts";

const allSatisfied: RootlessProbeResults = {
  subidConfigured: true,
  hasUidmapTools: true,
  cgroupsV2Delegated: true,
  hasXdgRuntimeDir: true,
};

const classify = (overrides: Partial<RootlessProbeResults>) =>
  classifyRootlessFailure({ ...allSatisfied, ...overrides });

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

  test("flags missing cgroups v2 delegation", () => {
    const error = classify({ cgroupsV2Delegated: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("cgroups-v2-delegation");
    expect(error?.remediation).toContain("Delegate");
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
    const error = classify({ subidConfigured: false, hasUidmapTools: false });

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error?.prerequisite).toBe("subid");
  });

  test("RootlessPrerequisiteError remains a tagged provider error", () => {
    const error = new RootlessPrerequisiteError("subid");

    expect(error).toBeInstanceOf(RootlessPrerequisiteError);
    expect(error._tag).toEqual(expect.any(String));
    expect(error._tag.length).toBeGreaterThan(0);
  });

  test("cgroups v2 delegation requires controllers on the user service cgroup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-cgroups-"));
    try {
      await writeFile(join(dir, "cgroup.controllers"), "cpu memory pids\n");
      expect(hasCgroupsV2Delegation(dir, "1000")).toBe(false);

      const userServiceDir = join(dir, "user.slice", "user-1000.slice", "user@1000.service");
      await mkdir(userServiceDir, { recursive: true });
      await writeFile(join(userServiceDir, "cgroup.controllers"), "cpu memory pids\n");

      expect(hasCgroupsV2Delegation(dir, "1000")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
