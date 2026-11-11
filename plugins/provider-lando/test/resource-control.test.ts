import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { layer as makeProviderLayer } from "@lando/provider-lando";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { declaredProviderLandoCapabilities, withResourceControl } from "../src/capabilities.ts";
import type { DelegatedScopeHost } from "../src/delegated-scope.ts";
import type { PodmanServiceRunner } from "../src/podman-service-runner.ts";

const userService = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service";

const host = (eligible: boolean): DelegatedScopeHost => {
  const files: Record<string, string> = eligible
    ? {
        "/run/user/1000/systemd/private": "",
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids",
        [`${userService}/cgroup.controllers`]: "cpu memory pids",
      }
    : { "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids" };
  return {
    uid: () => 1000,
    isExecutable: (path) => ["/usr/bin/systemd-run", "/usr/bin/env"].includes(path),
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
    const declared = withResourceControl(base, { declared: true });
    expect(new Set(declared.composeKnobs?.supported)).toEqual(
      new Set([...(base.composeKnobs?.supported ?? []), "deploy.resources"]),
    );
  });
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

  const liveKnobs = async (input: {
    readonly eligible: boolean;
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
              delegatedScopeHost: host(input.eligible),
            }),
          ),
        ),
      );
      return resourceKnobs(provider.capabilities);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

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
  });
});
