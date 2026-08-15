/**
 * Characterization test for doctor reports supplied by bundled plugin
 * descriptors:
 *
 *   1. The file-sync contribution reads real files under `<userDataRoot>/bin`.
 *      These deterministic temp-directory fixtures preserve the report shapes
 *      for missing, stale, current, and partially verified installs.
 *   2. A provider-conflict contribution marked `preempts: true` returns ONLY
 *      preemptive reports and never calls `registry.select()`.
 *
 * PRE-EXISTING COVERAGE (reused, not duplicated): `core/test/cli/doctor.test.ts`
 * already has an equivalent "emits a provider-conflict check before selecting
 * provider-podman" scenario (same `select: () => Effect.die(...)` trick). This
 * file re-derives that same contract here alongside the file-sync contribution
 * so the plugin wiring has one focused characterization surface.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Context, Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/core/paths";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import {
  MUTAGEN_TOOL_MANIFEST,
  MUTAGEN_TOOL_VERSION,
  mutagenInstalledVersionPath,
} from "@lando/file-sync-mutagen";
import { AbsolutePath, type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { resolveHostKey } from "@lando/sdk/tool-provisioning";

import { type DoctorCheck, doctor } from "../../src/cli/commands/doctor.ts";

const buildConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const slowBindMountProvider = { ...TestRuntimeProvider, id: "lando" as const };
Object.assign(slowBindMountProvider, {
  capabilities: { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" },
});

const buildRegistry = (provider: typeof TestRuntimeProvider) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const runDoctorWithUserDataRoot = (userDataRoot: string) =>
  Effect.runPromise(
    doctor().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimeProviderRegistry, buildRegistry(slowBindMountProvider)),
          Layer.succeed(ConfigService, buildConfigService({ userDataRoot: AbsolutePath.make(userDataRoot) })),
          Layer.succeed(PathsService, makeLandoPaths({ userDataRoot, platform: "linux", env: {} })),
        ),
      ),
    ),
  );

const fileSyncCheckFrom = (checks: ReadonlyArray<DoctorCheck>): DoctorCheck => {
  const check = checks.find((candidate) => candidate.name === "file-sync");
  if (check === undefined) throw new Error("expected a file-sync doctor check");
  return check;
};

/** Real host-key artifact install paths for the current process host, from the real Mutagen tool manifest. */
const currentHostInstallPaths = (binDir: string): ReadonlyArray<string> => {
  const hostKey = resolveHostKey(process.platform, process.arch);
  return Object.entries(MUTAGEN_TOOL_MANIFEST.artifacts)
    .filter(([key]) => key.startsWith(`${hostKey}/`))
    .map(([, artifact]) => join(binDir, artifact.installName));
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("doctor() file-sync plugin contribution", () => {
  test("missing: no mutagen install marker on disk yields a warn check with a `lando setup` solution", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-file-sync-missing-"));
    try {
      const result = await runDoctorWithUserDataRoot(dataRoot);
      const check = fileSyncCheckFrom(result.checks);

      expect(check.status).toBe("warn");
      expect(check.severity).toBe("warn");
      expect(check.runtimeStatus).toBe("not-installed");
      expect(check.runtime.running).toBe(false);
      expect(check.runtime).not.toHaveProperty("version");
      expect(check.context).toEqual({
        engineId: "mutagen",
        mutagenVersion: "not-installed",
        expectedVersion: MUTAGEN_TOOL_VERSION,
      });
      expect(check.solutions).toEqual([
        {
          kind: "manual",
          description: "Run `lando setup` to download the Mutagen host CLI and agent binaries.",
          command: "lando setup",
        },
      ]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("installed-mismatched: a stale recorded version yields a warn check reporting the STALE version, not the expected one", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-file-sync-mismatch-"));
    try {
      const binDir = makeLandoPaths({ userDataRoot: dataRoot }).binDir;
      await mkdir(binDir, { recursive: true });
      await writeFile(mutagenInstalledVersionPath(binDir), "v0.0.0-stale\n", "utf8");

      const result = await runDoctorWithUserDataRoot(dataRoot);
      const check = fileSyncCheckFrom(result.checks);

      expect(check.status).toBe("warn");
      expect(check.runtimeStatus).toBe("installed");
      expect(check.runtime.running).toBe(false);
      expect(check.runtime.version).toBe("v0.0.0-stale");
      expect(check.context.mutagenVersion).toBe("v0.0.0-stale");
      expect(check.context.expectedVersion).toBe(MUTAGEN_TOOL_VERSION);
      expect(check.solutions).toHaveLength(1);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("installed-matching: the correct version PLUS a valid fingerprint for every current-host artifact yields a pass check with no solutions", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-file-sync-current-"));
    try {
      const binDir = makeLandoPaths({ userDataRoot: dataRoot }).binDir;
      await mkdir(binDir, { recursive: true });
      await writeFile(mutagenInstalledVersionPath(binDir), `${MUTAGEN_TOOL_VERSION}\n`, "utf8");

      const installPaths = currentHostInstallPaths(binDir);
      expect(installPaths.length).toBeGreaterThan(0);
      for (const installPath of installPaths) {
        await mkdir(join(installPath, ".."), { recursive: true });
        const bytes = new TextEncoder().encode(`fake-mutagen-binary:${installPath}`);
        await writeFile(installPath, bytes);
        await writeFile(`${installPath}.sha256`, sha256Hex(bytes), "utf8");
      }

      const result = await runDoctorWithUserDataRoot(dataRoot);
      const check = fileSyncCheckFrom(result.checks);

      expect(check.status).toBe("pass");
      expect(check.severity).toBe("info");
      expect(check.runtimeStatus).toBe("installed");
      expect(check.runtime.running).toBe(true);
      expect(check.runtime.version).toBe(MUTAGEN_TOOL_VERSION);
      expect(check.context.mutagenVersion).toBe(MUTAGEN_TOOL_VERSION);
      expect(check.solutions).toEqual([]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("installed-matching but ONE missing fingerprint file still fails the check (all artifacts must verify)", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-file-sync-partial-"));
    try {
      const binDir = makeLandoPaths({ userDataRoot: dataRoot }).binDir;
      await mkdir(binDir, { recursive: true });
      await writeFile(mutagenInstalledVersionPath(binDir), `${MUTAGEN_TOOL_VERSION}\n`, "utf8");

      const installPaths = currentHostInstallPaths(binDir);
      // Deliberately skip the fingerprint file for the first artifact only.
      for (const [index, installPath] of installPaths.entries()) {
        await mkdir(join(installPath, ".."), { recursive: true });
        const bytes = new TextEncoder().encode(`fake-mutagen-binary:${installPath}`);
        await writeFile(installPath, bytes);
        if (index !== 0) await writeFile(`${installPath}.sha256`, sha256Hex(bytes), "utf8");
      }

      const result = await runDoctorWithUserDataRoot(dataRoot);
      const check = fileSyncCheckFrom(result.checks);

      expect(check.status).toBe("warn");
      expect(check.runtimeStatus).toBe("installed");
      expect(check.runtime.running).toBe(false);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe("doctor() provider-conflict short-circuit (contract: a detected conflict returns ONLY conflict checks and never calls registry.select())", () => {
  const writeProviderLandoState = async (stateRoot: string, socketPath: string): Promise<void> => {
    const dir = join(stateRoot, "providers", "provider-lando");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "setup-state.json"), JSON.stringify({ socketPath }), "utf8");
  };

  test("never constructs the resolved provider when a socket conflict is detected for it", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-plugin-coupling-conflict-"));
    try {
      const socket = "/run/user/1000/podman/podman.sock";
      await writeProviderLandoState(dataRoot, socket);

      const registryThatMustNotConstruct = {
        list: Effect.succeed([ProviderId.make("podman")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () =>
          Effect.die(
            "registry.select() must not be called: a provider conflict was already detected for this id",
          ),
      };

      const result = await Effect.runPromise(
        doctor({
          env: { LANDO_PROVIDER: "podman", XDG_RUNTIME_DIR: "/run/user/1000" },
          platform: "linux",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RuntimeProviderRegistry, registryThatMustNotConstruct),
              Layer.succeed(ConfigService, buildConfigService({ userDataRoot: AbsolutePath.make(dataRoot) })),
              Layer.succeed(
                PathsService,
                makeLandoPaths({ userDataRoot: dataRoot, platform: "linux", env: {} }),
              ),
            ),
          ),
        ),
      );

      // ONLY the conflict report — no selected-provider, file-sync, setup-readiness,
      // runtime-service, host-proxy, or oom checks.
      expect(result.checks).toHaveLength(1);
      expect(result.checks.map((check) => check.name)).toEqual(["provider-conflict"]);
      expect(result.checks[0]?.status).toBe("warn");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
