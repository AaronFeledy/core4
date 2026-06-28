import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeRuntimeProvider } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PodmanApiClient } from "../src/capabilities.ts";
import type { PodmanServiceRunner, PodmanServiceSpec } from "../src/podman-service-runner.ts";
import { probeRuntimeServiceStatus } from "../src/runtime-status.ts";

const unavailable = () =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "podman-api",
    message: "unreachable",
    remediation: "test remediation",
  });

const reachableApi = (): PodmanApiClient => ({ info: Effect.succeed({}) });
const unreachableApi = (): PodmanApiClient => ({ info: Effect.fail(unavailable()) });

const spec = (dir: string): PodmanServiceSpec => ({
  command: join(dir, "bin", "podman"),
  args: ["system", "service", "--time=0", `unix://${join(dir, "run", "podman.sock")}`],
  socketPath: join(dir, "run", "podman.sock"),
});

const serviceRunner = (options: {
  readonly alivePids?: ReadonlySet<number>;
  readonly servicePids?: ReadonlySet<number>;
  readonly matchingPids?: ReadonlyArray<number>;
}): PodmanServiceRunner => ({
  launch: () => Effect.succeed(9999),
  isAlive: (pid) => Effect.succeed(options.alivePids?.has(pid) ?? false),
  isServiceProcess: (pid) => Effect.succeed(options.servicePids?.has(pid) ?? false),
  ...(options.matchingPids === undefined
    ? {}
    : {
        findMatchingServicePids: () => Effect.succeed(options.matchingPids ?? []),
      }),
  terminate: () => Effect.void,
});

describe("probeRuntimeServiceStatus", () => {
  test("running/socketReachable=false when podmanApi.info fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-runtime-status-"));
    try {
      const status = await Effect.runPromise(
        probeRuntimeServiceStatus({
          podmanApi: unreachableApi(),
          serviceRunner: serviceRunner({}),
          spec: spec(dir),
          pidPath: join(dir, "podman.pid"),
        }),
      );

      expect(status.running).toBe(false);
      expect(status.socketReachable).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("running/socketReachable=true when info ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-runtime-status-"));
    try {
      const status = await Effect.runPromise(
        probeRuntimeServiceStatus({
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner({}),
          spec: spec(dir),
          pidPath: join(dir, "podman.pid"),
        }),
      );

      expect(status.running).toBe(true);
      expect(status.socketReachable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pid + ownedServiceProcess=true when info ok, pid file present and alive owned process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-runtime-status-"));
    try {
      const pidPath = join(dir, "podman.pid");
      await writeFile(pidPath, "4321");

      const status = await Effect.runPromise(
        probeRuntimeServiceStatus({
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner({ alivePids: new Set([4321]), servicePids: new Set([4321]) }),
          spec: spec(dir),
          pidPath,
        }),
      );

      expect(status.pid).toBe(4321);
      expect(status.ownedServiceProcess).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ownedServiceProcess=false when pid alive but isServiceProcess false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-runtime-status-"));
    try {
      const pidPath = join(dir, "podman.pid");
      await writeFile(pidPath, "4321");

      const status = await Effect.runPromise(
        probeRuntimeServiceStatus({
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner({ alivePids: new Set([4321]), servicePids: new Set() }),
          spec: spec(dir),
          pidPath,
        }),
      );

      expect(status.pid).toBe(4321);
      expect(status.ownedServiceProcess).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("orphanPids surfaced when findMatchingServicePids returns an alive pid different from owned pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-runtime-status-"));
    try {
      const pidPath = join(dir, "podman.pid");
      await writeFile(pidPath, "4321");

      const status = await Effect.runPromise(
        probeRuntimeServiceStatus({
          podmanApi: reachableApi(),
          serviceRunner: serviceRunner({
            alivePids: new Set([4321, 7777]),
            servicePids: new Set([4321]),
            matchingPids: [4321, 7777, 8888],
          }),
          spec: spec(dir),
          pidPath,
        }),
      );

      expect(status.orphanPids).toEqual([7777]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("socketReachable=false and no pid when podmanApi undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-runtime-status-"));
    try {
      const status = await Effect.runPromise(
        probeRuntimeServiceStatus({
          serviceRunner: serviceRunner({}),
          spec: spec(dir),
          pidPath: join(dir, "podman.pid"),
        }),
      );

      expect(status.running).toBe(false);
      expect(status.socketReachable).toBe(false);
      expect(status.pid).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("provider-lando runtime status", () => {
  test("getStatus returns narrow {running, message} shape matching reachability", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({ podmanApi: reachableApi(), platform: "linux" }),
    );

    const status = await Effect.runPromise(provider.getStatus);

    expect(Object.keys(status).sort()).toEqual(["message", "running"]);
    expect(status.running).toBe(true);
    expect(status.message).toContain("runtime socket reachable");
  });

  test("teardownRuntimeService is a no-op when provider is not managing a runtime", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({ podmanApi: reachableApi(), platform: "linux" }),
    );

    const result = await Effect.runPromise(provider.teardownRuntimeService);

    expect(result).toEqual({ terminated: false });
  });
});
