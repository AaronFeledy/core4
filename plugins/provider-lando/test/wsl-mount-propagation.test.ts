import { describe, expect, test } from "bun:test";
import { Effect, Either, Schema } from "effect";

import type { HostPlatform } from "@lando/sdk/schema";
import { PluginDoctorReport } from "@lando/sdk/schema";

import { makeWslMountPropagationCheck, parseRootMountPropagation } from "../src/wsl-mount-propagation.ts";

const privateRootMount =
  "82 67 8:48 / / rw,relatime - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered";
const sharedRootMount =
  "82 67 8:48 / / rw,relatime shared:1 - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered";

const runCheck = (
  platform: HostPlatform,
  mountinfo: string,
  env: Readonly<Record<string, string | undefined>> = {},
) =>
  Effect.runPromise(
    makeWslMountPropagationCheck({
      readMountinfo: async () => mountinfo,
    }).run({
      providerId: "lando",
      platform,
      env,
      userDataRoot: undefined,
      binDir: undefined,
      stateDir: undefined,
    }),
  );

describe("parseRootMountPropagation", () => {
  test("returns private when the well-formed root entry has no shared tag", () => {
    // Given: a real private root mountinfo entry.

    // When: root propagation is parsed.
    const propagation = parseRootMountPropagation(privateRootMount);

    // Then: the root mount is classified as private.
    expect(propagation).toBe("private");
  });

  test("returns shared when the root optional fields contain a shared tag", () => {
    // Given: a root entry with a shared propagation tag.

    // When: root propagation is parsed.
    const propagation = parseRootMountPropagation(sharedRootMount);

    // Then: the root mount is classified as shared.
    expect(propagation).toBe("shared");
  });

  test("finds a shared tag among multiple root optional fields", () => {
    // Given: a root entry with multiple optional fields.
    const mountinfo =
      "82 67 8:48 / / rw,relatime shared:1 master:2 - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered";

    // When: root propagation is parsed.
    const propagation = parseRootMountPropagation(mountinfo);

    // Then: the shared tag determines the result.
    expect(propagation).toBe("shared");
  });

  test("ignores shared tags on non-root mount points", () => {
    // Given: /mnt/wsl is shared while the root mount is private.
    const mountinfo = ["101 82 0:45 / /mnt/wsl rw,relatime shared:1 - tmpfs tmpfs rw", privateRootMount].join(
      "\n",
    );

    // When: root propagation is parsed.
    const propagation = parseRootMountPropagation(mountinfo);

    // Then: only the exact root mount-point field is considered.
    expect(propagation).toBe("private");
  });

  for (const [fixture, mountinfo] of [
    ["empty input", ""],
    ["garbage input", "not mountinfo"],
    ["missing root entry", "101 82 0:45 / /mnt/wsl rw shared:1 - tmpfs tmpfs rw"],
  ] as const) {
    test(`returns unknown for ${fixture}`, () => {
      // Given: mountinfo that cannot identify a well-formed root entry.

      // When: root propagation is parsed.
      const propagation = parseRootMountPropagation(mountinfo);

      // Then: the parser declines to infer private propagation.
      expect(propagation).toBe("unknown");
    });
  }
});

describe("makeWslMountPropagationCheck", () => {
  for (const platform of ["darwin", "win32"] as const) {
    test(`returns no reports on ${platform}`, async () => {
      // Given: a non-WSL platform and private mountinfo.

      // When: the doctor contribution runs.
      const reports = await runCheck(platform, privateRootMount);

      // Then: the WSL-only warning is absent.
      expect(reports).toEqual([]);
    });
  }

  test("returns no reports on linux without injected WSL markers", async () => {
    // Given: Linux without injected WSL environment markers.

    // When: the doctor contribution runs.
    const reports = await runCheck("linux", privateRootMount);

    // Then: the injected inputs do not identify WSL.
    expect(reports).toEqual([]);
  });

  for (const [marker, env] of [
    ["WSL_DISTRO_NAME", { WSL_DISTRO_NAME: "Ubuntu" }],
    ["WSL_INTEROP", { WSL_INTEROP: "/run/WSL/1_interop" }],
  ] as const) {
    test(`detects WSL on linux from the injected ${marker} marker`, async () => {
      // Given: Linux with one injected WSL environment marker and private root propagation.

      // When: the doctor contribution runs.
      const reports = await runCheck("linux", privateRootMount, env);

      // Then: the WSL private-root warning is surfaced.
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ status: "warn", severity: "warn" });
    });
  }

  test("returns one warning with immediate and persistent remediations on WSL private root", async () => {
    // Given: WSL with private root mount propagation.

    // When: the doctor contribution runs.
    const reports = await runCheck("wsl", privateRootMount);

    // Then: one schema-valid warning offers both remediation paths.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "warn", severity: "warn" });
    expect(reports[0]?.solutions.length).toBeGreaterThanOrEqual(2);
    expect(reports[0]?.solutions[0]).toMatchObject({
      kind: "manual",
      command: "sudo mount --make-rshared /",
    });
    expect(reports[0]?.solutions[1]?.description).toContain("/etc/wsl.conf");
    const decoded = Schema.decodeUnknownEither(PluginDoctorReport, { onExcessProperty: "error" })(reports[0]);
    expect(Either.isRight(decoded)).toBe(true);
  });

  test("returns no reports on WSL when root propagation is shared", async () => {
    // Given: WSL with shared root mount propagation.

    // When: the doctor contribution runs.
    const reports = await runCheck("wsl", sharedRootMount);

    // Then: no warning is needed.
    expect(reports).toEqual([]);
  });

  test("returns no reports on WSL when mountinfo is unknown", async () => {
    // Given: WSL with unreadable mountinfo content.

    // When: the doctor contribution runs.
    const reports = await runCheck("wsl", "garbage");

    // Then: an uncertain parse never creates a warning.
    expect(reports).toEqual([]);
  });
});
