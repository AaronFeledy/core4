import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { layer as makeProviderLayer } from "@lando/provider-lando";
import { type ProcessRunner, RuntimeProvider } from "@lando/sdk/services";
import { type Context, Effect, Stream } from "effect";
import { declaredProviderLandoCapabilities, withResourceControl } from "../src/capabilities.ts";
import type { DelegatedScopeHost } from "../src/delegated-scope.ts";
import type { PodmanServiceRunner } from "../src/podman-service-runner.ts";

const userService = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service";

const host = (eligible: boolean, tools = ["/usr/bin/systemd-run", "/usr/bin/env"]): DelegatedScopeHost => {
  const files: Record<string, string> = eligible
    ? {
        "/run/user/1000/systemd/private": "",
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids",
        [`${userService}/cgroup.controllers`]: "cpu memory pids",
      }
    : { "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids" };
  return {
    uid: () => 1000,
    isExecutable: (path) => tools.includes(path),
    exists: (path) => path in files,
    readText: (path) => files[path],
    ownerUid: () => undefined,
  };
};

const resourceKnobs = (capabilities: ReturnType<typeof declaredProviderLandoCapabilities>) => ({
  declared: capabilities.composeKnobs?.supported.includes("deploy.resources") ?? false,
  remediation: capabilities.composeKnobs?.withheld?.find((entry) => entry.key === "deploy.resources")
    ?.remediation,
});

describe("declared deploy.resources", () => {
  test("Linux declares it when the next launch can run in a delegated user scope", () => {
    expect(resourceKnobs(declaredProviderLandoCapabilities("linux", "x64", host(true)))).toEqual({
      declared: true,
      remediation: undefined,
    });
  });

  test("Linux without a user manager withholds it and says how to get one", () => {
    const knobs = resourceKnobs(declaredProviderLandoCapabilities("linux", "x64", host(false)));
    expect(knobs.declared).toBe(false);
    expect(knobs.remediation).toContain("loginctl enable-linger $USER");
  });

  test.each(["darwin", "win32"] as const)(
    "%s withholds it until machine enforcement is verified",
    (platform) => {
      expect(resourceKnobs(declaredProviderLandoCapabilities(platform, "arm64", host(true))).declared).toBe(
        false,
      );
    },
  );

  test("declaring it keeps every other libpod knob", () => {
    const base = declaredProviderLandoCapabilities("linux", "x64", host(false));
    const declared = withResourceControl(base, { delegated: true });
    expect(new Set(declared.composeKnobs?.supported)).toEqual(
      new Set([...(base.composeKnobs?.supported ?? []), "deploy.resources"]),
    );
  });
});

const withSystemctl = ["/usr/bin/systemd-run", "/usr/bin/env", "/usr/bin/systemctl"];
const nativeHealth = (capabilities: ReturnType<typeof declaredProviderLandoCapabilities>) => ({
  serviceHealth: capabilities.serviceHealth,
  startInterval:
    capabilities.composePreservedPaths?.supported.includes("healthcheck.start_interval") ?? false,
});

const idleProcessRunner: Context.Service.Shape<typeof ProcessRunner> = {
  run: () => Effect.die("capabilities must not spawn"),
  stream: () => Stream.die("capabilities must not spawn"),
  streamWithExit: () => Stream.die("capabilities must not spawn"),
};

describe("declared native health", () => {
  test("Linux schedules it, and so realizes start_interval, when the launch is delegated and systemctl exists", () => {
    expect(
      nativeHealth(declaredProviderLandoCapabilities("linux", "x64", host(true, withSystemctl))),
    ).toEqual({
      serviceHealth: "lando",
      startInterval: true,
    });
  });

  test.each([
    ["no systemctl", host(true)],
    ["no delegated launch", host(false, withSystemctl)],
  ])("Linux with %s reports that nothing schedules it", (_name, linuxHost) => {
    expect(nativeHealth(declaredProviderLandoCapabilities("linux", "x64", linuxHost))).toEqual({
      serviceHealth: "none",
      startInterval: false,
    });
  });

  test.each(["darwin", "win32"] as const)(
    "%s machines schedule it natively and drop start_interval",
    (platform) => {
      expect(
        nativeHealth(declaredProviderLandoCapabilities(platform, "arm64", host(true, withSystemctl))),
      ).toEqual({
        serviceHealth: "native",
        startInterval: false,
      });
    },
  );
});

describe("live deploy.resources for the managed Linux runtime", () => {
  const runner = (alive: boolean): PodmanServiceRunner => ({
    launch: () => Effect.die("capabilities must not launch"),
    isAlive: () => Effect.succeed(alive),
    isServiceProcess: () => Effect.succeed(alive),
    terminate: () => Effect.die("capabilities must not terminate"),
  });
  const api = (containers: ReadonlyArray<{ readonly State: string }>): PodmanApiClient => ({
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: () => Effect.succeed({ status: 200, body: JSON.stringify(containers) }),
  });

  const liveCapabilities = async (input: {
    readonly eligible: boolean;
    readonly tools?: ReadonlyArray<string>;
    readonly processRunner?: boolean;
    readonly running?: {
      readonly containerCgroups?: string;
      readonly containers: ReadonlyArray<{ readonly State: string }>;
    };
  }) => {
    const dir = await mkdtemp(join(tmpdir(), "lando-live-resources-"));
    try {
      const pidPath = join(dir, "run", "podman.pid");
      if (input.running !== undefined) {
        await Bun.write(pidPath, "4321");
        await writeFile(
          `${pidPath}.launch.json`,
          JSON.stringify({
            pid: 4321,
            env: {},
            ...(input.running.containerCgroups === undefined
              ? {}
              : { containerCgroups: input.running.containerCgroups }),
          }),
        );
      }
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              sanitizeAppliedPlan: stripHostProxyRunLando,
              platform: "linux",
              runtimeBinDir: join(dir, "bin"),
              runtimeRunDir: join(dir, "run"),
              runtimeStorageDir: join(dir, "storage"),
              runtimeConfigDir: join(dir, "config"),
              providerSocketPath: join(dir, "run", "podman.sock"),
              providerPidPath: pidPath,
              podmanApiFactory: () => api(input.running?.containers ?? []),
              podmanService: runner(input.running !== undefined),
              delegatedScopeHost: host(input.eligible, [
                ...(input.tools ?? ["/usr/bin/systemd-run", "/usr/bin/env"]),
              ]),
              ...(input.processRunner === true ? { processRunner: idleProcessRunner } : {}),
            }),
          ),
        ),
      );
      return provider.capabilities;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const liveKnobs = async (input: Parameters<typeof liveCapabilities>[0]) =>
    resourceKnobs(await liveCapabilities(input));

  test("a delegated running service with systemctl and a process runner gets Lando-scheduled health", async () => {
    const running = { containerCgroups: "delegated", containers: [] };
    expect(
      nativeHealth(
        await liveCapabilities({ eligible: true, tools: withSystemctl, processRunner: true, running }),
      ),
    ).toEqual({ serviceHealth: "lando", startInterval: true });
    expect(
      nativeHealth(await liveCapabilities({ eligible: true, tools: withSystemctl, running })).serviceHealth,
    ).toBe("none");
  });

  test("a running service observed delegated declares it even when the host is no longer eligible", async () => {
    expect(
      (await liveKnobs({ eligible: false, running: { containerCgroups: "delegated", containers: [] } }))
        .declared,
    ).toBe(true);
  });

  test("a running shared service with running containers withholds it and asks for a poweroff", async () => {
    const knobs = await liveKnobs({
      eligible: true,
      running: { containerCgroups: "shared", containers: [{ State: "running" }] },
    });
    expect(knobs.declared).toBe(false);
    expect(knobs.remediation).toContain("lando poweroff");
  });

  test("a running shared service with no running containers declares it: the next ensure relaunches it", async () => {
    expect(
      (
        await liveKnobs({
          eligible: true,
          running: { containerCgroups: "shared", containers: [{ State: "exited" }] },
        })
      ).declared,
    ).toBe(true);
  });

  test.each([true, false])(
    "with no running service the next launch decides (eligible=%p)",
    async (eligible) => {
      expect((await liveKnobs({ eligible })).declared).toBe(eligible);
    },
  );

  test("an external socket never declares it", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            socketPath: "/tmp/external-podman.sock",
            podmanApiFactory: () => api([]),
            delegatedScopeHost: host(true),
          }),
        ),
      ),
    );
    expect(resourceKnobs(provider.capabilities).declared).toBe(false);
    expect(nativeHealth(provider.capabilities)).toEqual({ serviceHealth: "none", startInterval: false });
  });
});
