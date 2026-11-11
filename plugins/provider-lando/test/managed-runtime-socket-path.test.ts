import { describe, expect, test } from "bun:test";
import { MANAGED_SOCKET_PATH_MAX_BYTES } from "@lando/container-runtime/podman/managed-invocation";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";
import { PluginDoctorReport } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";

import {
  MANAGED_SOCKET_DATA_ROOT_SUFFIX,
  makeManagedRuntimeSocketPathCheck,
  managedSocketMaxDataRootBytes,
  managedSocketPathForDataRoot,
  managedSocketPathOverLimitError,
  managedSocketPathOverLimitRemediation,
  validateManagedSocketPathLength,
} from "../src/managed-runtime-socket-path.ts";

const runCheck = (platform: HostPlatform, userDataRoot: string | undefined, providerId = "lando") =>
  Effect.runPromise(
    makeManagedRuntimeSocketPathCheck().run({
      providerId,
      platform,
      env: {},
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    }),
  );

describe("managed socket path limits", () => {
  test("max data root is 107 minus the fixed runtime socket suffix", () => {
    const max = managedSocketMaxDataRootBytes;

    expect(MANAGED_SOCKET_DATA_ROOT_SUFFIX).toBe("/runtime/run/podman.sock");
    expect(max).toBe(
      MANAGED_SOCKET_PATH_MAX_BYTES - Buffer.byteLength(MANAGED_SOCKET_DATA_ROOT_SUFFIX, "utf8"),
    );
    expect(max).toBe(83);
    expect(managedSocketPathOverLimitRemediation(max)).toBe(
      "Set LANDO_USER_DATA_ROOT to a path of at most 83 bytes, then rerun the command.",
    );
  });

  test("accepts a socket path at the 107-byte boundary", () => {
    const socketPath = `/${"a".repeat(106)}`;

    const error = validateManagedSocketPathLength(socketPath);

    expect(Buffer.byteLength(socketPath, "utf8")).toBe(107);
    expect(error).toBeUndefined();
  });

  test("rejects a socket path over 107 UTF-8 bytes with shared details", () => {
    const socketPath = `/${"a".repeat(107)}`;

    const error = validateManagedSocketPathLength(socketPath, { operation: "plan-setup" });

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error?.operation).toBe("plan-setup");
    expect(error?.remediation).toBe(
      "Set LANDO_USER_DATA_ROOT to a path of at most 83 bytes, then rerun the command.",
    );
    expect(error?.details).toEqual({
      socketPath,
      bytes: 108,
      limit: 107,
      maxDataRootBytes: 83,
    });
  });

  test("rejects multibyte paths by UTF-8 byte length, not string length", () => {
    const socketPath = `/${"é".repeat(54)}`;

    const error = managedSocketPathOverLimitError({ socketPath });

    expect(error.details).toMatchObject({ bytes: 109, limit: 107, maxDataRootBytes: 83 });
  });
});

describe("makeManagedRuntimeSocketPathCheck", () => {
  test.each(["docker", "podman"])("returns no reports for provider %s", async (providerId) => {
    expect(await runCheck("linux", `/${"a".repeat(100)}`, providerId)).toEqual([]);
  });
  for (const platform of ["darwin", "win32"] as const) {
    test(`returns no reports on ${platform}`, async () => {
      const root = `/${"a".repeat(100)}`;

      const reports = await runCheck(platform, root);

      expect(reports).toEqual([]);
    });
  }

  test("returns no reports when userDataRoot is missing", async () => {
    const reports = await runCheck("linux", undefined);

    expect(reports).toEqual([]);
  });

  test("returns no reports when the managed socket path is within the limit", async () => {
    const root = "/tmp/lando-short-root";

    const reports = await runCheck("linux", root);

    expect(Buffer.byteLength(managedSocketPathForDataRoot(root), "utf8")).toBeLessThanOrEqual(107);
    expect(reports).toEqual([]);
  });

  test("returns no reports on WSL when the path is within the limit", async () => {
    const root = "/home/user/.local/share/lando";

    const reports = await runCheck("wsl", root);

    expect(reports).toEqual([]);
  });

  test("returns one fail report with the shared remediation when over limit", async () => {
    const root = `/${"b".repeat(managedSocketMaxDataRootBytes + 1)}`;
    const socketPath = managedSocketPathForDataRoot(root);

    const reports = await runCheck("linux", root);

    expect(Buffer.byteLength(socketPath, "utf8")).toBeGreaterThan(107);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      name: "managed-runtime-socket-path",
      status: "fail",
      severity: "error",
    });
    expect(reports[0]?.solutions[0]).toMatchObject({
      kind: "manual",
      description: "Set LANDO_USER_DATA_ROOT to a path of at most 83 bytes, then rerun the command.",
    });
    expect(reports[0]?.context).toMatchObject({
      socketPath,
      limit: "107",
      maxDataRootBytes: "83",
    });
    const decoded = Schema.decodeUnknownResult(PluginDoctorReport, { onExcessProperty: "error" })(reports[0]);
    expect(Result.isSuccess(decoded)).toBe(true);
  });
});
