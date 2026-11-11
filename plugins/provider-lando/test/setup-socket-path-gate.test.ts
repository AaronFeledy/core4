import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Exit } from "effect";

import { makeRuntimeProvider } from "../src/index.ts";
import {
  managedSocketMaxDataRootBytes,
  managedSocketPathForDataRoot,
  managedSocketPathOverLimitRemediation,
} from "../src/managed-runtime-socket-path.ts";

const readyProbes = {
  probe: () => ({
    subidConfigured: true,
    subidRangeSufficient: true,
    subidRangesDisjoint: true,
    hasUidmapTools: true,
    cgroupsV2Delegated: true,
    hasXdgRuntimeDir: true,
  }),
};

const managedProvider = (userDataRoot: string, platform: "linux" | "darwin", downloads: string[] = []) =>
  Effect.runPromise(
    makeRuntimeProvider({
      platform,
      ...(platform === "darwin" ? { arch: "arm64" } : {}),
      sanitizeAppliedPlan: stripHostProxyRunLando,
      userDataRoot,
      stateDir: join(userDataRoot, "providers"),
      runtimeBinDir: join(userDataRoot, "runtime", "bin"),
      runtimeRunDir: join(userDataRoot, "runtime", "run"),
      runtimeStorageDir: join(userDataRoot, "runtime", "storage"),
      runtimeConfigDir: join(userDataRoot, "runtime", "config"),
      providerSocketPath: managedSocketPathForDataRoot(userDataRoot),
      providerPidPath: join(userDataRoot, "runtime", "run", "podman.pid"),
      rootlessProbes: readyProbes,
      artifactDownload: () => {
        downloads.push("download");
        return Effect.die("download must not run");
      },
    }),
  );

describe("provider-lando planSetup managed socket path gate", () => {
  test("accepts a short Linux managed data root", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-socket-ok-"));
    try {
      const provider = await managedProvider(userDataRoot, "linux");

      const plan = await Effect.runPromise(provider.planSetup({ force: false }));

      expect(plan.providerId).toBe(ProviderId.make("lando"));
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("fails before downloads when the managed socket path exceeds 107 UTF-8 bytes", async () => {
    const userDataRoot = `/${"c".repeat(managedSocketMaxDataRootBytes)}`;
    const socketPath = managedSocketPathForDataRoot(userDataRoot);
    const downloads: string[] = [];
    const provider = await managedProvider(userDataRoot, "linux", downloads);

    const exit = await Effect.runPromiseExit(provider.planSetup({ force: false }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === "None") throw new Error("expected a tagged failure");
    const error = failure.value;
    if (!(error instanceof ProviderUnavailableError)) throw new Error(`unexpected ${String(error)}`);
    expect(error.operation).toBe("plan-setup");
    expect(error.remediation).toBe(managedSocketPathOverLimitRemediation());
    expect(error.details).toEqual({
      socketPath,
      bytes: 108,
      limit: 107,
      maxDataRootBytes: managedSocketMaxDataRootBytes,
    });
    expect(downloads).toEqual([]);
  });

  test("skips the socket-length gate on darwin managed hosts", async () => {
    const userDataRoot = `/${"d".repeat(managedSocketMaxDataRootBytes + 1)}`;
    const provider = await managedProvider(userDataRoot, "darwin");

    const plan = await Effect.runPromise(provider.planSetup({ force: false }));

    expect(plan).toEqual({ providerId: ProviderId.make("lando"), changes: [] });
  });
});
