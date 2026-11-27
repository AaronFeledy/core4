import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { layer as makeProviderLayer } from "@lando/provider-lando";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";
import { declaredProviderLandoCapabilities } from "../src/capabilities.ts";
import type { DelegatedScopeHost } from "../src/delegated-scope.ts";
import { outdatedRuntimeRemediation, withNativeHealth } from "../src/native-health-runtime.ts";
import type { PodmanServiceRunner } from "../src/podman-service-runner.ts";
import { RUNTIME_BUNDLE_MANIFEST } from "../src/runtime-bundle.ts";

const noUserManager: DelegatedScopeHost = {
  uid: () => 1000,
  isExecutable: () => false,
  exists: () => false,
  readText: () => undefined,
  ownerUid: () => undefined,
};

const nativeHealth = (capabilities: ProviderCapabilities) => ({
  serviceHealth: capabilities.serviceHealth,
  startInterval:
    capabilities.composePreservedPaths?.supported.includes("healthcheck.start_interval") ?? false,
  remediation: capabilities.composePreservedPaths?.withheld?.find(
    (entry) => entry.key === "healthcheck.start_interval",
  )?.remediation,
});

interface ManagedRuntime {
  readonly installed?: string;
  /** A running owned service: its launch record version and the PID its acknowledgement names. */
  readonly service?: { readonly recorded?: string; readonly ack?: string };
}

const liveNativeHealth = async (runtime: ManagedRuntime) => {
  const dir = await mkdtemp(join(tmpdir(), "lando-native-health-"));
  try {
    const binDir = join(dir, "bin");
    const runDir = join(dir, "run");
    const pidPath = join(runDir, "podman.pid");
    await mkdir(binDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    if (runtime.installed !== undefined)
      await writeFile(join(binDir, ".runtime-installed-version"), `${runtime.installed}\n`);
    if (runtime.service !== undefined) {
      await writeFile(pidPath, "4321");
      await writeFile(
        `${pidPath}.launch.json`,
        JSON.stringify({
          pid: 4321,
          env: {},
          ...(runtime.service.recorded === undefined
            ? {}
            : { runtimeBundleVersion: runtime.service.recorded }),
        }),
      );
      if (runtime.service.ack !== undefined)
        await writeFile(join(runDir, "healthcheck-scheduler.pid"), runtime.service.ack);
    }
    const running = runtime.service !== undefined;
    const runner: PodmanServiceRunner = {
      launch: () => Effect.die("capabilities must not launch"),
      isAlive: () => Effect.succeed(running),
      isServiceProcess: () => Effect.succeed(running),
      // Rootless Podman serves from a user-namespace child of the launched PID 4321.
      isDescendant: (pid, ancestor) => Effect.succeed(pid === 4322 && ancestor === 4321),
      terminate: () => Effect.die("capabilities must not terminate"),
    };
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            runtimeBinDir: binDir,
            runtimeRunDir: runDir,
            runtimeStorageDir: join(dir, "storage"),
            runtimeConfigDir: join(dir, "config"),
            providerSocketPath: join(runDir, "podman.sock"),
            providerPidPath: pidPath,
            podmanApiFactory: () => ({ info: Effect.succeed({}), ping: Effect.succeed(undefined) }),
            podmanService: runner,
          }),
        ),
      ),
    );
    return nativeHealth(provider.capabilities);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("native health on the managed Linux runtime", () => {
  test("a runtime without the scheduler reports nothing schedules checks and withholds start_interval", async () => {
    expect(await liveNativeHealth({ installed: "0.1.8", service: { recorded: "0.1.8" } })).toEqual({
      serviceHealth: "none",
      startInterval: false,
      remediation: outdatedRuntimeRemediation(),
    });
  });

  test("a scheduler-bearing runtime with no service running lets the next launch schedule", async () => {
    expect(await liveNativeHealth({ installed: "0.1.9" })).toEqual({
      serviceHealth: "native",
      startInterval: true,
      remediation: undefined,
    });
  });

  test("a running service counts only when its acknowledgement names it or its serving child", async () => {
    for (const ack of ["4321\n", "4322\n"]) {
      expect(
        await liveNativeHealth({ installed: "0.1.9", service: { recorded: "0.1.9", ack } }),
      ).toMatchObject({ serviceHealth: "native", startInterval: true });
    }
    for (const service of [
      { recorded: "0.1.9", ack: "1234\n" },
      { recorded: "0.1.9", ack: "4322" },
      { recorded: "0.1.9" },
    ]) {
      const health = await liveNativeHealth({ installed: "0.1.9", service });
      expect(health).toMatchObject({ serviceHealth: "none", startInterval: false });
      expect(health.remediation).toContain("lando poweroff");
    }
  });

  test("a running service launched from an older runtime is replaced by the next launch, which schedules", async () => {
    // Ensure relaunches a service whose recorded launch differs from the one it would start.
    for (const service of [{ recorded: "0.1.8", ack: "4321\n" }, { ack: "4321\n" }]) {
      expect(await liveNativeHealth({ installed: "0.1.9", service })).toEqual({
        serviceHealth: "native",
        startInterval: true,
        remediation: undefined,
      });
    }
  });

  test("an external socket never vouches for native health", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            socketPath: "/tmp/external-podman.sock",
            podmanApiFactory: () => ({ info: Effect.succeed({}), ping: Effect.succeed(undefined) }),
          }),
        ),
      ),
    );
    expect(nativeHealth(provider.capabilities)).toMatchObject({
      serviceHealth: "none",
      startInterval: false,
    });
  });

  test("scheduling keeps every other preserved path the base declaration lists", () => {
    const base = {
      ...declaredProviderLandoCapabilities("linux", "x64", noUserManager),
      composePreservedPaths: { supported: ["depends_on.*.restart" as const] },
    };
    expect(withNativeHealth(base, { scheduled: true, by: "service" }).composePreservedPaths).toEqual({
      supported: ["depends_on.*.restart", "healthcheck.start_interval"],
    });
    expect(
      withNativeHealth(base, { scheduled: false, reason: "runtime-outdated", remediation: "Update." })
        .composePreservedPaths,
    ).toEqual({
      supported: ["depends_on.*.restart"],
      withheld: [{ key: "healthcheck.start_interval", remediation: "Update." }],
    });
  });

  test("the offline declaration follows the runtime the next setup installs", () => {
    const declared = nativeHealth(declaredProviderLandoCapabilities("linux", "x64", noUserManager));
    const schedules = Bun.semver.satisfies(RUNTIME_BUNDLE_MANIFEST.runtimeVersion, ">=0.1.9");
    expect(declared).toEqual({
      serviceHealth: schedules ? "native" : "none",
      startInterval: schedules,
      remediation: schedules ? undefined : outdatedRuntimeRemediation(),
    });
  });

  test("the outdated-runtime remediation sends users to setup only when setup installs a scheduler", () => {
    expect(outdatedRuntimeRemediation("0.1.9")).toContain("Run `lando setup`");
    expect(outdatedRuntimeRemediation("0.1.8")).not.toContain("lando setup");
    expect(outdatedRuntimeRemediation("0.1.8")).toContain("0.1.9");
  });
});
