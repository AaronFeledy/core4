import { describe, expect, test } from "bun:test";

import {
  CRUN_OOM_SCORE_ADJ_BROKEN_AT,
  CRUN_OOM_SCORE_ADJ_FIXED_VERSION,
  CRUN_OOM_SCORE_ADJ_ISSUE_URL,
  CRUN_OOM_SCORE_ADJ_REMEDIATION,
  KNOWN_BAD_CRUN,
  type KnownBadOciRuntime,
  PODMAN_EXEC_CLAMP_AFTER,
  PODMAN_EXEC_CLAMP_VERSION,
  evaluateKnownBadOciRuntime,
  evaluateLibpodCrunExecCompatibility,
  parseOciRuntimeBanner,
  parseRuntimeVersionNumbers,
  versionAtLeast,
  versionAtMost,
  versionGreaterThan,
} from "../src/podman/oci-runtime-floor.ts";

const CRUN_1_31_BANNER = `crun version 1.31
commit: 0e849780ccb4da009a6241f28d71be20957ba56d
rundir: /run/user/1000/crun
spec: 1.0.0
+SYSTEMD +SELINUX +APPARMOR +CAP +SECCOMP +EBPF +CRIU +YAJL
`;

const libpodInfo = (options: {
  readonly podmanVersion?: string;
  readonly rootless?: boolean;
  readonly runtimeName?: string;
  readonly runtimeVersion?: string;
  readonly omitHost?: boolean;
  readonly omitRuntime?: boolean;
  readonly omitVersion?: boolean;
}): unknown => ({
  ...(options.omitVersion === true ? {} : { version: { Version: options.podmanVersion ?? "6.1.3" } }),
  ...(options.omitHost === true
    ? {}
    : {
        host: {
          security: { rootless: options.rootless ?? true },
          ...(options.omitRuntime === true
            ? {}
            : {
                ociRuntime: {
                  name: options.runtimeName ?? "crun",
                  version: options.runtimeVersion ?? CRUN_1_31_BANNER,
                },
              }),
        },
      }),
});

describe("OCI runtime version banner", () => {
  test("parses the first line of a multi-line crun banner", () => {
    expect(parseOciRuntimeBanner("crun", CRUN_1_31_BANNER)).toEqual({ name: "crun", version: "1.31" });
  });

  test("parses a three-part banner version", () => {
    expect(parseOciRuntimeBanner("crun", "crun version 1.31.0\ncommit: abc\n")).toEqual({
      name: "crun",
      version: "1.31.0",
    });
  });

  test("rejects a missing banner", () => {
    expect(parseOciRuntimeBanner("crun", "")).toBeUndefined();
  });

  test("rejects a bare semver that is not a banner", () => {
    expect(parseOciRuntimeBanner("crun", "1.31")).toBeUndefined();
    expect(parseOciRuntimeBanner("crun", "1.31.0")).toBeUndefined();
  });

  test("rejects garbage and a mismatched runtime name", () => {
    expect(parseOciRuntimeBanner("crun", "not a version banner")).toBeUndefined();
    expect(parseOciRuntimeBanner("crun", "runc version 1.1.12\n")).toBeUndefined();
    expect(parseOciRuntimeBanner("runc", CRUN_1_31_BANNER)).toBeUndefined();
  });

  test("parses two- and three-part numeric versions", () => {
    expect(parseRuntimeVersionNumbers("1.31")).toEqual({ major: 1, minor: 31, patch: 0 });
    expect(parseRuntimeVersionNumbers("1.31.2")).toEqual({ major: 1, minor: 31, patch: 2 });
    expect(parseRuntimeVersionNumbers("6.1.3-dev")).toEqual({ major: 6, minor: 1, patch: 3 });
    expect(parseRuntimeVersionNumbers("garbage")).toBeUndefined();
  });
});

describe("known-bad crun range", () => {
  test("warns for rootless system Podman in the broken range", () => {
    const warning = evaluateKnownBadOciRuntime({
      runtimeName: "crun",
      runtimeVersionBanner: CRUN_1_31_BANNER,
      podmanVersion: "6.1.3",
      rootless: true,
    });
    expect(warning).toMatchObject({
      runtimeName: "crun",
      runtimeVersion: "1.31",
      podmanVersion: "6.1.3",
      issueUrl: CRUN_OOM_SCORE_ADJ_ISSUE_URL,
      remediation: CRUN_OOM_SCORE_ADJ_REMEDIATION,
    });
    expect(warning?.message).toContain("6.1.3");
    expect(warning?.message).toContain("1.31");
    expect(warning?.message).toContain("lando setup");
  });

  test("warns at 6.2.0 and at later Podman versions until a clamp release is recorded", () => {
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: CRUN_1_31_BANNER,
        podmanVersion: "6.2.0",
        rootless: true,
      })?.podmanVersion,
    ).toBe("6.2.0");
    expect(PODMAN_EXEC_CLAMP_VERSION).toBeUndefined();
    expect(KNOWN_BAD_CRUN.podmanExecClampVersion).toBeUndefined();
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: CRUN_1_31_BANNER,
        podmanVersion: "6.2.1",
        rootless: true,
      })?.podmanVersion,
    ).toBe("6.2.1");
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: CRUN_1_31_BANNER,
        podmanVersion: "6.3.0",
        rootless: true,
      })?.podmanVersion,
    ).toBe("6.3.0");
  });

  test("does not warn below the crun floor", () => {
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: "crun version 1.28\ncommit: abc\n",
        podmanVersion: "6.1.3",
        rootless: true,
      }),
    ).toBeUndefined();
  });

  test("does not warn for rootful Podman", () => {
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: CRUN_1_31_BANNER,
        podmanVersion: "6.1.3",
        rootless: false,
      }),
    ).toBeUndefined();
  });

  test("does not warn when rootless is unknown", () => {
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: CRUN_1_31_BANNER,
        podmanVersion: "6.1.3",
        rootless: undefined,
      }),
    ).toBeUndefined();
  });

  test("does not warn for a missing or unparseable banner", () => {
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: undefined,
        podmanVersion: "6.1.3",
        rootless: true,
      }),
    ).toBeUndefined();
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: "1.31",
        podmanVersion: "6.1.3",
        rootless: true,
      }),
    ).toBeUndefined();
    expect(
      evaluateKnownBadOciRuntime({
        runtimeName: "crun",
        runtimeVersionBanner: "garbage",
        podmanVersion: "6.1.3",
        rootless: true,
      }),
    ).toBeUndefined();
  });

  test("retires the warning when a Podman clamp version is recorded", () => {
    expect(PODMAN_EXEC_CLAMP_VERSION).toBeUndefined();
    expect(versionGreaterThan("6.2.1", PODMAN_EXEC_CLAMP_AFTER)).toBe(true);
    const withClamp: KnownBadOciRuntime = {
      ...KNOWN_BAD_CRUN,
      podmanExecClampVersion: "6.3.0",
    };
    expect(
      evaluateKnownBadOciRuntime(
        {
          runtimeName: "crun",
          runtimeVersionBanner: CRUN_1_31_BANNER,
          podmanVersion: "6.2.1",
          rootless: true,
        },
        withClamp,
      )?.podmanVersion,
    ).toBe("6.2.1");
    expect(
      evaluateKnownBadOciRuntime(
        {
          runtimeName: "crun",
          runtimeVersionBanner: CRUN_1_31_BANNER,
          podmanVersion: "6.3.0",
          rootless: true,
        },
        withClamp,
      ),
    ).toBeUndefined();
    expect(
      evaluateKnownBadOciRuntime(
        {
          runtimeName: "crun",
          runtimeVersionBanner: CRUN_1_31_BANNER,
          podmanVersion: "6.3.1",
          rootless: true,
        },
        withClamp,
      ),
    ).toBeUndefined();
  });

  test("retires the warning when a fixed crun version is recorded", () => {
    expect(CRUN_OOM_SCORE_ADJ_FIXED_VERSION).toBeUndefined();
    const withFix: KnownBadOciRuntime = {
      ...KNOWN_BAD_CRUN,
      fixedRuntimeVersion: "1.32.0",
    };
    expect(
      evaluateKnownBadOciRuntime(
        {
          runtimeName: "crun",
          runtimeVersionBanner: "crun version 1.32.0\ncommit: abc\n",
          podmanVersion: "6.1.3",
          rootless: true,
        },
        withFix,
      ),
    ).toBeUndefined();
    expect(
      evaluateKnownBadOciRuntime(
        {
          runtimeName: "crun",
          runtimeVersionBanner: CRUN_1_31_BANNER,
          podmanVersion: "6.1.3",
          rootless: true,
        },
        withFix,
      )?.runtimeVersion,
    ).toBe("1.31");
  });

  test("compares inclusive bounds numerically", () => {
    expect(versionAtLeast("1.31", CRUN_OOM_SCORE_ADJ_BROKEN_AT)).toBe(true);
    expect(versionAtLeast("1.30.9", CRUN_OOM_SCORE_ADJ_BROKEN_AT)).toBe(false);
    expect(versionAtMost("6.2.0", PODMAN_EXEC_CLAMP_AFTER)).toBe(true);
    expect(versionAtMost("6.2.1", PODMAN_EXEC_CLAMP_AFTER)).toBe(false);
  });
});

describe("libpod info evaluation", () => {
  test("warns from host.ociRuntime.version on rootless libpod info", () => {
    const warning = evaluateLibpodCrunExecCompatibility(libpodInfo({}));
    expect(warning?.runtimeVersion).toBe("1.31");
    expect(warning?.podmanVersion).toBe("6.1.3");
  });

  test("does not warn for rootful, missing, or garbage libpod fields", () => {
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ rootless: false }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ omitRuntime: true }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ omitHost: true }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ omitVersion: true }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ runtimeVersion: "1.31" }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ runtimeVersion: "nope" }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility(libpodInfo({ runtimeName: "runc" }))).toBeUndefined();
    expect(evaluateLibpodCrunExecCompatibility({})).toBeUndefined();
  });
});
