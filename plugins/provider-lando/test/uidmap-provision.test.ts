import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Duration, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderHostChangeRequest } from "@lando/sdk/services";
import { makeRuntimeProvider } from "../src/index.ts";
import {
  UIDMAP_PACKAGE_REQUEST,
  UidmapProvisionError,
  provisionUidmapTools,
} from "../src/uidmap-provision.ts";

const missingHelpersProbe = (installed: () => boolean) => ({
  probe: () => ({
    subidConfigured: true,
    hasUidmapTools: installed(),
    cgroupsV2Delegated: true,
    hasXdgRuntimeDir: true,
  }),
});

describe("Ubuntu uidmap provisioning", () => {
  test("explicit provider setup provisions before detached runtime launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-uidmap-setup-"));
    try {
      // Given: managed setup can inspect Podman but cannot ping until launch, and uidmap is absent.
      let installed = false;
      let launched = false;
      const calls: string[] = [];
      const taskEvents: Array<{ readonly _tag: string; readonly taskId?: string }> = [];
      const probes = missingHelpersProbe(() => installed);
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          linuxHostRelease: { id: "ubuntu", versionId: "26.04" },
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.1" } }),
            ping: Effect.suspend(() =>
              launched
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new ProviderUnavailableError({
                      providerId: "lando",
                      operation: "ping",
                      message: "offline",
                    }),
                  ),
            ),
          },
          podmanCommand: { version: Effect.succeed("podman version 6.0.1") },
          podmanService: {
            launch: () =>
              Effect.sync(() => {
                calls.push("launch");
                launched = true;
                return 4242;
              }),
            isAlive: () => Effect.succeed(false),
            isServiceProcess: () => Effect.succeed(false),
            terminate: (_pid, _spec) => Effect.void,
          },
          rootlessProbes: probes,
          runtimeStorageDir: join(dir, "storage"),
          runtimeRunDir: join(dir, "run"),
          runtimeConfigDir: join(dir, "config"),
          providerSocketPath: join(dir, "run", "podman.sock"),
          providerPidPath: join(dir, "run", "podman.pid"),
          readinessPolicy: {
            maxAttempts: 2,
            delay: Duration.millis(1),
            timeout: Duration.millis(50),
          },
          eventService: {
            publish: (event) =>
              Effect.sync(() => {
                taskEvents.push(event);
              }),
          },
        }),
      );

      // When: explicit setup consents and supplies privilege elevation.
      await Effect.runPromise(
        Effect.scoped(
          provider.setup({
            force: false,
            hostChangeConsent: () => Effect.succeed(true),
            privilege: {
              elevate: (argv) =>
                Effect.sync(() => {
                  calls.push(argv.join(" "));
                  if (argv[1] === "install") installed = true;
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
            },
          }),
        ),
      );

      // Then: both fixed host operations and verification happen before launch.
      expect(calls).toEqual([
        "/usr/bin/apt-get update",
        "/usr/bin/apt-get install --yes --no-install-recommends uidmap",
        "launch",
      ]);
      expect(
        taskEvents.filter((event) => event._tag === "task.complete").map((event) => event.taskId),
      ).toEqual(["podman", "socket", "prerequisites", "launch", "readiness"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("requests host-change consent before the setup task tree acquires the terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-uidmap-consent-order-"));
    try {
      // Given: uidmap is absent, so provisioning must prompt for consent.
      let installed = false;
      let launched = false;
      const order: string[] = [];
      const probes = missingHelpersProbe(() => installed);
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          linuxHostRelease: { id: "ubuntu", versionId: "26.04" },
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.1" } }),
            ping: Effect.suspend(() =>
              launched
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new ProviderUnavailableError({
                      providerId: "lando",
                      operation: "ping",
                      message: "offline",
                    }),
                  ),
            ),
          },
          podmanCommand: { version: Effect.succeed("podman version 6.0.1") },
          podmanService: {
            launch: () =>
              Effect.sync(() => {
                launched = true;
                return 4242;
              }),
            isAlive: () => Effect.succeed(false),
            isServiceProcess: () => Effect.succeed(false),
            terminate: (_pid, _spec) => Effect.void,
          },
          rootlessProbes: probes,
          runtimeStorageDir: join(dir, "storage"),
          runtimeRunDir: join(dir, "run"),
          runtimeConfigDir: join(dir, "config"),
          providerSocketPath: join(dir, "run", "podman.sock"),
          providerPidPath: join(dir, "run", "podman.pid"),
          readinessPolicy: {
            maxAttempts: 2,
            delay: Duration.millis(1),
            timeout: Duration.millis(50),
          },
          eventService: {
            publish: (event) =>
              Effect.sync(() => {
                if (event._tag === "task.tree.start") order.push("task.tree.start");
              }),
          },
        }),
      );

      // When: explicit setup consents to the fixed host change.
      await Effect.runPromise(
        Effect.scoped(
          provider.setup({
            force: false,
            hostChangeConsent: () =>
              Effect.sync(() => {
                order.push("consent");
                return true;
              }),
            privilege: {
              elevate: (argv) =>
                Effect.sync(() => {
                  if (argv[1] === "install") installed = true;
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
            },
          }),
        ),
      );

      // Then: consent settles before the task-tree renderer owns the terminal, so the
      // OpenTUI prompt never competes with the split-footer substrate.
      expect(order).toEqual(["consent", "task.tree.start"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("consent receives the tagged uidmap package request before provisioning", async () => {
    // Given: supported Ubuntu 26.04 is missing both uidmap helpers.
    let installed = false;
    const elevated: ReadonlyArray<string>[] = [];
    const requests: ProviderHostChangeRequest[] = [];

    // When: the explicit setup provisioning adapter receives consent.
    await Effect.runPromise(
      provisionUidmapTools({
        host: { id: "ubuntu", versionId: "26.04" },
        probes: missingHelpersProbe(() => installed),
        consent: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return true;
          }),
        privilege: {
          elevate: (argv) =>
            Effect.sync(() => {
              elevated.push([...argv]);
              if (argv[1] === "install") installed = true;
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );

    // Then: setup asks once, uses only fixed argv, and succeeds after re-probe.
    expect(UIDMAP_PACKAGE_REQUEST._tag).toBe("package-install");
    expect(requests).toEqual([UIDMAP_PACKAGE_REQUEST]);
    expect(elevated).toEqual([
      ["/usr/bin/apt-get", "update"],
      ["/usr/bin/apt-get", "install", "--yes", "--no-install-recommends", "uidmap"],
    ]);
  });

  test("unsupported hosts fail closed before privilege elevation", async () => {
    // Given: a non-reference Linux distribution is missing uidmap helpers.
    const elevated: ReadonlyArray<string>[] = [];

    // When: explicit setup evaluates provisioning policy.
    const exit = await Effect.runPromiseExit(
      provisionUidmapTools({
        host: { id: "debian", versionId: "13" },
        probes: missingHelpersProbe(() => false),
        consent: () => Effect.succeed(true),
        privilege: {
          elevate: (argv) =>
            Effect.sync(() => {
              elevated.push([...argv]);
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );

    // Then: policy remains fail-closed with a stable unsupported-host stage.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(elevated).toEqual([]);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UidmapProvisionError);
      if (exit.cause.error instanceof UidmapProvisionError) {
        expect(exit.cause.error.stage).toBe("unsupported-host");
      }
    }
  });

  test("denied noninteractive provisioning fails before privilege elevation", async () => {
    // Given: the supported host is missing helpers but host changes are denied.
    const elevated: ReadonlyArray<string>[] = [];

    // When: setup requests consent.
    const exit = await Effect.runPromiseExit(
      provisionUidmapTools({
        host: { id: "ubuntu", versionId: "26.04" },
        probes: missingHelpersProbe(() => false),
        consent: () => Effect.succeed(false),
        privilege: {
          elevate: (argv) =>
            Effect.sync(() => {
              elevated.push([...argv]);
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );

    // Then: setup fails immediately with unattended remediation.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(elevated).toEqual([]);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.remediation).toContain("--yes --no-interactive");
    }
  });

  test.each([
    ["update", 0],
    ["install", 1],
  ] as const)("reports a stable %s stage when apt-get fails", async (stage, failingCall) => {
    // Given: the fixed package operation fails at one known stage.
    let call = 0;

    // When: provisioning executes the fixed apt-get plan.
    const exit = await Effect.runPromiseExit(
      provisionUidmapTools({
        host: { id: "ubuntu", versionId: "26.04" },
        probes: missingHelpersProbe(() => false),
        consent: () => Effect.succeed(true),
        privilege: {
          elevate: () =>
            Effect.sync(() => ({
              exitCode: call++ === failingCall ? 1 : 0,
              stdout: "",
              stderr: `${stage} failed`,
            })),
        },
      }),
    );

    // Then: callers receive the stage and actual apt-get output.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UidmapProvisionError);
      if (exit.cause.error instanceof UidmapProvisionError) {
        expect(exit.cause.error.stage).toBe(stage);
        expect(exit.cause.error.message).toContain(`${stage} failed`);
      }
    }
  });

  test("reports verify stage when helpers remain absent after install", async () => {
    // Given: apt-get succeeds but neither helper appears on the re-probe.
    // When: provisioning verifies the host change.
    const exit = await Effect.runPromiseExit(
      provisionUidmapTools({
        host: { id: "ubuntu", versionId: "26.04" },
        probes: missingHelpersProbe(() => false),
        consent: () => Effect.succeed(true),
        privilege: {
          elevate: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        },
      }),
    );

    // Then: verification has its own stable tagged failure stage.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UidmapProvisionError);
      if (exit.cause.error instanceof UidmapProvisionError) {
        expect(exit.cause.error.stage).toBe("verify");
      }
    }
  });
});
