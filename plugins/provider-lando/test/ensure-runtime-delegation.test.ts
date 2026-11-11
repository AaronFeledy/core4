import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Duration, Effect } from "effect";
import type { DelegatedScopeHost } from "../src/delegated-scope.ts";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import {
  type PodmanServiceRunner,
  type PodmanServiceScope,
  buildPodmanServiceArgs,
  podmanServiceLogPath,
} from "../src/podman-service-runner.ts";

const userService = "/user.slice/user-1000.slice/user@1000.service";
const scopeCgroup = `${userService}/app.slice/run-p9999-i1.scope`;

const host = (input: { readonly eligible: boolean; readonly placement: string }): DelegatedScopeHost => {
  const files: Record<string, string> = {
    "/run/user/1000/systemd/private": "",
    "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids",
    [`/sys/fs/cgroup${userService}/cgroup.controllers`]: "cpu memory pids",
    "/proc/9999/cgroup": `0::${input.placement}\n`,
    [`/sys/fs/cgroup${input.placement}/cgroup.controllers`]: "cpu memory pids",
  };
  return {
    uid: () => 1000,
    isExecutable: (path) => input.eligible && ["/usr/bin/systemd-run", "/usr/bin/env"].includes(path),
    exists: (path) => path in files,
    readText: (path) => files[path],
    ownerUid: (path) => (path === `/sys/fs/cgroup${input.placement}` && path.includes("user@") ? 1000 : 0),
  };
};

interface Recorded {
  readonly scopes: Array<PodmanServiceScope | undefined>;
  readonly terminated: number[];
}

const runner = (recorded: Recorded, existing?: { readonly pid: number }): PodmanServiceRunner => ({
  launch: (_spec, scope) =>
    Effect.sync(() => {
      recorded.scopes.push(scope);
      return 9999;
    }),
  isAlive: (pid) => Effect.succeed(pid === existing?.pid && !recorded.terminated.includes(pid)),
  isServiceProcess: (pid) => Effect.succeed(pid === existing?.pid),
  terminate: (pid) =>
    Effect.sync(() => {
      recorded.terminated.push(pid);
    }),
});

const api = (containers: ReadonlyArray<{ readonly State: string }>): PodmanApiClient => ({
  info: Effect.succeed({}),
  ping: Effect.succeed(undefined),
  request: () => Effect.succeed({ status: 200, body: JSON.stringify(containers) }),
});

const withRuntime = async (
  run: (p: ReturnType<typeof paths>, dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-delegated-launch-"));
  try {
    await run(paths(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const paths = (dir: string) => ({
  podmanBin: join(dir, "bin", "podman"),
  storageDir: join(dir, "storage"),
  runRoot: join(dir, "run"),
  configDir: join(dir, "config"),
  socketPath: join(dir, "podman.sock"),
  pidPath: join(dir, "podman.pid"),
  privateRuntimeDir: "/private/test-runtime",
});

const launchRecord = async (p: ReturnType<typeof paths>) =>
  JSON.parse(await readFile(`${p.pidPath}.launch.json`, "utf8")) as Record<string, unknown>;

const writeRunningService = async (p: ReturnType<typeof paths>, containerCgroups?: string) => {
  await writeFile(p.pidPath, "4321");
  await writeFile(
    `${p.pidPath}.launch.json`,
    JSON.stringify({
      pid: 4321,
      env: buildPodmanServiceArgs(p).env,
      ...(containerCgroups === undefined ? {} : { containerCgroups }),
    }),
  );
};

describe("ensureRuntime delegated scope launch", () => {
  test("an eligible host launches through the host systemd-run and records the delegated placement", async () => {
    await withRuntime(async (p) => {
      // Given: an eligible host with no running service.
      const recorded: Recorded = { scopes: [], terminated: [] };

      // When
      await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: runner(recorded),
          podmanApi: api([]),
          delegatedScope: host({ eligible: true, placement: scopeCgroup }),
        }),
      );

      // Then
      expect(recorded.scopes).toEqual([
        { systemdRun: "/usr/bin/systemd-run", userRuntimeDir: "/run/user/1000" },
      ]);
      expect(await launchRecord(p)).toMatchObject({ pid: 9999, containerCgroups: "delegated" });
    });
  });

  test("a selected delegated launch that lands in a shared cgroup is stopped and fails", async () => {
    await withRuntime(async (p) => {
      // Given: systemd-run accepted the launch, but the service runs in the root-owned init scope.
      const recorded: Recorded = { scopes: [], terminated: [] };

      // When
      const exit = await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: runner(recorded),
          podmanApi: api([]),
          delegatedScope: host({ eligible: true, placement: "/init.scope" }),
        }).pipe(Effect.flip),
      );

      // Then: no silent shared fallback.
      expect(exit).toBeInstanceOf(ProviderUnavailableError);
      expect(exit.message).toContain("delegated systemd user scope");
      expect(exit.details).toMatchObject({ pid: 9999, cgroup: "/init.scope" });
      expect(recorded.terminated).toEqual([9999]);
    });
  });

  test("an ineligible host launches undelegated and records the shared placement", async () => {
    await withRuntime(async (p) => {
      const recorded: Recorded = { scopes: [], terminated: [] };

      await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: runner(recorded),
          podmanApi: api([]),
          delegatedScope: host({ eligible: false, placement: "/init.scope" }),
        }),
      );

      expect(recorded.scopes).toEqual([undefined]);
      expect(await launchRecord(p)).toMatchObject({ pid: 9999, containerCgroups: "shared" });
    });
  });

  test.each([
    { label: "an observed shared placement", containerCgroups: "shared" },
    { label: "no recorded placement", containerCgroups: undefined },
  ])(
    "a healthy service with $label and no running containers is relaunched delegated",
    async ({ containerCgroups }) => {
      await withRuntime(async (p) => {
        // Given: the running owned service predates delegation, and every container is stopped.
        const recorded: Recorded = { scopes: [], terminated: [] };
        await writeRunningService(p, containerCgroups);

        // When
        await Effect.runPromise(
          ensureRuntime({
            ...p,
            platform: "linux",
            serviceRunner: runner(recorded, { pid: 4321 }),
            podmanApi: api([{ State: "exited" }]),
            delegatedScope: host({ eligible: true, placement: scopeCgroup }),
            terminationPolicy: { maxAttempts: 2, delay: Duration.millis(1), timeout: Duration.millis(50) },
          }),
        );

        // Then: only the API process is replaced; the private runtime dir is the same.
        expect(recorded.terminated).toEqual([4321]);
        expect(recorded.scopes).toHaveLength(1);
        expect(await launchRecord(p)).toMatchObject({
          pid: 9999,
          containerCgroups: "delegated",
          env: { XDG_RUNTIME_DIR: "/private/test-runtime" },
        });
      });
    },
  );

  test.each([
    { label: "running containers", containerCgroups: "shared", containers: [{ State: "running" }] },
    { label: "a delegated placement", containerCgroups: "delegated", containers: [] },
  ])("a healthy service with $label is kept", async ({ containerCgroups, containers }) => {
    await withRuntime(async (p) => {
      const recorded: Recorded = { scopes: [], terminated: [] };
      await writeRunningService(p, containerCgroups);

      await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: runner(recorded, { pid: 4321 }),
          podmanApi: api(containers),
          delegatedScope: host({ eligible: true, placement: scopeCgroup }),
        }),
      );

      expect(recorded.terminated).toEqual([]);
      expect(recorded.scopes).toEqual([]);
    });
  });

  test("a systemd-run failure surfaces through the early-exit path with its stderr", async () => {
    await withRuntime(async (p) => {
      // Given: the launcher exits before the service answers.
      const failing: PodmanServiceRunner = {
        launch: (spec) =>
          Effect.promise(async () => {
            await writeFile(
              podmanServiceLogPath(spec.socketPath),
              "Failed to connect to user scope bus via local transport: No such file or directory\n",
            );
            return 9999;
          }),
        isAlive: () => Effect.succeed(false),
        isServiceProcess: () => Effect.succeed(false),
        terminate: () => Effect.void,
        waitForExit: () => Effect.succeed(1),
      };
      const unreachable: PodmanApiClient = {
        info: Effect.never,
        ping: Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "podman-api",
            message: "unreachable",
            remediation: "test",
          }),
        ),
      };

      // When
      const error = await Effect.runPromise(
        ensureRuntime({
          ...p,
          platform: "linux",
          serviceRunner: failing,
          podmanApi: unreachable,
          delegatedScope: host({ eligible: true, placement: scopeCgroup }),
          readinessPolicy: { maxAttempts: 200, delay: Duration.millis(5), timeout: Duration.seconds(5) },
        }).pipe(Effect.flip),
      );

      // Then
      expect(error.message).toContain("exited before becoming ready (exit 1)");
      expect(error.details).toMatchObject({
        stderr: expect.stringContaining("Failed to connect to user scope bus"),
      });
    });
  });
});
