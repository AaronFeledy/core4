import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Cause, Effect, Exit } from "effect";

import {
  type ArtifactDownload,
  PodmanMachinePrerequisiteError,
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  ProviderBundleChecksumError,
  RUNTIME_BUNDLE_MANIFEST_ENV,
  WindowsMachinePrerequisiteError,
  ensureMacOSPodmanMachine,
  ensureWindowsPodmanMachine,
  makeProviderLayer,
  makeRuntimeProvider,
  makeSystemPodmanMachineRunner,
  providerStatePath,
  setupProviderLando,
  stopMacOSPodmanMachine,
  stopWindowsPodmanMachine,
  teardownMacOSPodmanMachine,
  teardownWindowsPodmanMachine,
  upgradeMacOSPodmanMachine,
  upgradeWindowsPodmanMachine,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider } from "@lando/sdk/services";
import type { PodmanMachineRunner, PodmanMachineStatus, RuntimeSetupProgress } from "../src/setup.ts";

const podmanCommand = (version: string) => ({ version: Effect.succeed(version) });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const withoutRuntimeBundleManifestEnv = async <A>(run: () => Promise<A>): Promise<A> => {
  const previous = process.env[RUNTIME_BUNDLE_MANIFEST_ENV];
  delete process.env[RUNTIME_BUNDLE_MANIFEST_ENV];
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[RUNTIME_BUNDLE_MANIFEST_ENV];
    } else {
      process.env[RUNTIME_BUNDLE_MANIFEST_ENV] = previous;
    }
  }
};

const machineRunner = (status: PodmanMachineStatus, calls: string[]): PodmanMachineRunner => ({
  inspect: Effect.sync(() => {
    calls.push("inspect");
    return status;
  }),
  create: Effect.sync(() => calls.push("create")).pipe(Effect.asVoid),
  start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
  stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
  upgrade: Effect.sync(() => calls.push("upgrade")).pipe(Effect.asVoid),
  teardown: Effect.sync(() => calls.push("teardown")).pipe(Effect.asVoid),
});

describe("provider-lando setup", () => {
  test("fails with remediation when Podman is not installed", async () => {
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        podmanCommand: { version: Effect.fail(new PodmanNotInstalledError()) },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        expect(failure.value).toBeInstanceOf(PodmanNotInstalledError);
        expect(failure.value.remediation).toContain("Install Podman >=");
      }
    }
  });

  test("fails with remediation when the Podman socket is not reachable", async () => {
    const previousSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
    delete process.env.LANDO_TEST_PODMAN_SOCKET;

    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({ podmanCommand: podmanCommand("podman version 6.0.2") }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value).toBeInstanceOf(PodmanSocketUnreachableError);
          expect(failure.value.remediation).toBe(
            "Run `systemctl --user start podman.socket` and rerun `lando setup`.",
          );
        }
      }
    } finally {
      if (previousSocket === undefined) {
        // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
        delete process.env.LANDO_TEST_PODMAN_SOCKET;
      } else {
        process.env.LANDO_TEST_PODMAN_SOCKET = previousSocket;
      }
    }
  });

  test("succeeds with a reachable socket and reports the detected Podman version", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-state-"));
    const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: {
              info: Effect.succeed({ version: { Version: "6.0.2" } }),
              ping: Effect.succeed(undefined),
            },
            podmanCommand: podmanCommand("podman version 6.0.2"),
            runtimeBundleDownloader: {
              download: Effect.succeed({
                version: "0.0.0-test",
                bytes: bundleBytes,
                sha256: sha256(bundleBytes),
              }),
            },
            socketPath: "/tmp/lando-test.sock",
            stateDir,
          }),
        ),
      ),
    );

    try {
      await Effect.runPromise(Effect.scoped(provider.setup({ force: false })));

      const versions = await Effect.runPromise(provider.getVersions);
      expect(versions.runtime).toBe("6.0.2");

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state).toEqual({
        podmanVersion: "6.0.2",
        runtimeBundleVersion: "0.0.0-test",
        runtimeBundleSha256: sha256(bundleBytes),
        socketPath: "/tmp/lando-test.sock",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("creates and starts the macOS Podman machine when it is missing", async () => {
    const calls: string[] = [];

    await Effect.runPromise(ensureMacOSPodmanMachine(machineRunner("missing", calls)));

    expect(calls).toEqual(["inspect", "create", "start"]);
  });

  test("starts the macOS Podman machine when it is stopped", async () => {
    const calls: string[] = [];

    await Effect.runPromise(ensureMacOSPodmanMachine(machineRunner("stopped", calls)));

    expect(calls).toEqual(["inspect", "start"]);
  });

  test("leaves the macOS Podman machine running when it is already running", async () => {
    const calls: string[] = [];

    await Effect.runPromise(ensureMacOSPodmanMachine(machineRunner("running", calls)));

    expect(calls).toEqual(["inspect"]);
  });

  test("stops, upgrades, and tears down the macOS Podman machine through the fake client", async () => {
    const calls: string[] = [];
    const machine = machineRunner("running", calls);

    await Effect.runPromise(stopMacOSPodmanMachine(machine));
    await Effect.runPromise(upgradeMacOSPodmanMachine(machine));
    await Effect.runPromise(teardownMacOSPodmanMachine(machine));

    expect(calls).toEqual(["stop", "upgrade", "teardown"]);
  });

  test("runs macOS machine setup before validating the Podman API socket", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      setupProviderLando({
        platform: "darwin",
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.succeed(undefined),
        },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: machineRunner("missing", calls),
      }),
    );

    expect(calls).toEqual(["inspect", "create", "start"]);
    expect(result.podmanVersion).toBe("6.0.2");
  });

  test("fails with actionable remediation when macOS machine prerequisites are missing", async () => {
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        platform: "darwin",
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.succeed(undefined),
        },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: {
          ...machineRunner("missing", []),
          create: Effect.fail(
            new PodmanMachinePrerequisiteError({ stderr: "vfkit virtualization helper missing" }),
          ),
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PodmanMachinePrerequisiteError);
        expect(failure.value.remediation).toContain("virtualization");
        expect(failure.value.remediation).toContain("lando setup");
      }
    }
  });

  test("fails closed when the runtime bundle checksum does not match", async () => {
    const bundleBytes = new TextEncoder().encode("tampered lando runtime bundle");
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.succeed(undefined),
        },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        runtimeBundleDownloader: {
          download: Effect.succeed({ version: "0.0.0-test", bytes: bundleBytes, sha256: "bad-checksum" }),
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        expect(failure.value).toBeInstanceOf(ProviderBundleChecksumError);
        expect(failure.value.remediation).toContain("checksum");
        expect(failure.value.remediation).toContain("lando setup");
      }
    }
  });

  test("honors runtime-bundle-url over the default runtime-bundle downloader", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-override-bundle-"));
    const calls: string[] = [];
    let fetchedUrl: string | undefined;
    const artifactDownload: ArtifactDownload = (request) =>
      Effect.sync(() => {
        fetchedUrl = request.url;
        return {
          bytes: new TextEncoder().encode("tampered override runtime bundle"),
          sha256: request.expectedSha256,
          path: `${request.directory}/${request.filename}`,
        };
      });

    try {
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "win32",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("running", calls),
          artifactDownload,
          stateDir,
        }),
      );

      const exit = await Effect.runPromiseExit(
        provider
          .setup({
            force: false,
            runtimeBundleUrl: "https://example.invalid/custom-runtime.zip",
            runtimeBundleSha256: "a".repeat(64),
          })
          .pipe(Effect.scoped),
      );

      expect(fetchedUrl).toBe("https://example.invalid/custom-runtime.zip");
      expect(calls).toEqual([]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderBundleChecksumError);
        }
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("wires the default runtime-bundle downloader when provider setup has a state directory", async () => {
    await withoutRuntimeBundleManifestEnv(async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-default-bundle-"));
      const calls: string[] = [];
      let fetchedUrl: string | undefined;
      const artifactDownload: ArtifactDownload = (request) =>
        Effect.sync(() => {
          fetchedUrl = request.url;
          return {
            bytes: new TextEncoder().encode("tampered windows runtime bundle"),
            sha256: request.expectedSha256,
            path: `${request.directory}/${request.filename}`,
          };
        });

      try {
        const provider = await Effect.runPromise(
          makeRuntimeProvider({
            platform: "win32",
            podmanApi: {
              info: Effect.succeed({ version: { Version: "6.0.2" } }),
              ping: Effect.succeed(undefined),
            },
            podmanCommand: podmanCommand("podman version 6.0.2"),
            podmanMachine: machineRunner("running", calls),
            artifactDownload,
            stateDir,
          }),
        );

        const exit = await Effect.runPromiseExit(provider.setup({ force: false }).pipe(Effect.scoped));

        expect(fetchedUrl).toContain("lando-runtime-win32-x64.zip");
        expect(calls).toEqual([]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(ProviderBundleChecksumError);
          }
        }
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  test.skipIf(process.platform !== "darwin" || !process.env.LANDO_TEST_PROVIDER_LANDO_MACOS)(
    "runs provider-lando macOS machine setup against the host Podman machine",
    async () => {
      expect(process.platform).toBe("darwin");
      await Effect.runPromise(setupProviderLando({ platform: "darwin" }));
    },
    120_000,
  );

  test("publishes a task tree with one child task per setup phase on the happy path", async () => {
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-setup-events-"));

    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: {
            download: Effect.succeed({
              version: "0.0.0-test",
              bytes: bundleBytes,
              sha256: sha256(bundleBytes),
            }),
          },
          stateDir,
          eventService: {
            publish: (event) =>
              Effect.sync(() => {
                captured.push(event);
              }),
          },
        }),
      );

      const tags = captured.map((event) => event._tag);
      expect(tags[0]).toBe("task.tree.start");
      expect(tags[tags.length - 1]).toBe("task.tree.complete");

      const treeStart = captured[0];
      expect((treeStart?.children ?? []) as ReadonlyArray<string>).toEqual([
        "bundle",
        "podman",
        "socket",
        "state",
      ]);

      const completedIds = captured
        .filter((event) => event._tag === "task.complete")
        .map((event) => event.taskId as string);
      expect(completedIds).toEqual(["bundle", "podman", "socket", "state"]);

      const treeComplete = captured[captured.length - 1];
      expect(treeComplete?.succeeded).toBe(4);
      expect(treeComplete?.failed).toBe(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("omits the socket task when managed setup skips the socket probe", async () => {
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];

    await Effect.runPromise(
      setupProviderLando({
        platform: "linux",
        podmanCommand: podmanCommand("podman version 6.0.2"),
        skipSocketProbe: true,
        eventService: {
          publish: (event) =>
            Effect.sync(() => {
              captured.push(event);
            }),
        },
      }),
    );

    const treeStart = captured[0];
    expect((treeStart?.children ?? []) as ReadonlyArray<string>).toEqual(["podman"]);

    const startedIds = captured
      .filter((event) => event._tag === "task.start")
      .map((event) => event.taskId as string);
    const completedIds = captured
      .filter((event) => event._tag === "task.complete")
      .map((event) => event.taskId as string);
    expect(startedIds).toEqual(["podman"]);
    expect(completedIds).toEqual(["podman"]);

    const treeComplete = captured[captured.length - 1];
    expect(treeComplete?.succeeded).toBe(1);
    expect(treeComplete?.failed).toBe(0);
  });

  test("publishes explicit managed prerequisite, launch, and readiness tasks", async () => {
    // Given: managed runtime setup exposes its three ordered phases.
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const phases: string[] = [];

    // When: provider setup runs the managed runtime lifecycle.
    await Effect.runPromise(
      setupProviderLando({
        platform: "linux",
        podmanCommand: podmanCommand("podman version 6.0.2"),
        skipSocketProbe: true,
        managedRuntimeSetup: (progress: RuntimeSetupProgress) =>
          Effect.gen(function* () {
            for (const phase of ["prerequisites", "launch", "readiness"] as const) {
              yield* progress.run(
                phase,
                Effect.sync(() => {
                  phases.push(phase);
                }),
              );
            }
          }),
        eventService: {
          publish: (event) =>
            Effect.sync(() => {
              captured.push(event);
            }),
        },
      }),
    );

    // Then: the tree and event sequence make all runtime work visible.
    expect(captured[0]?.children).toEqual(["podman", "prerequisites", "launch", "readiness"]);
    expect(phases).toEqual(["prerequisites", "launch", "readiness"]);
    expect(captured.filter((event) => event._tag === "task.complete").map((event) => event.taskId)).toEqual([
      "podman",
      "prerequisites",
      "launch",
      "readiness",
    ]);
  });

  test("failed preflight reports the actual failure and settles unstarted runtime tasks", async () => {
    // Given: prerequisite preflight has actionable tagged failure details.
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "setup",
      message: "newuidmap and newgidmap are still unavailable.",
      remediation: "Install the Ubuntu uidmap package, then rerun `lando setup`.",
    });

    // When: the first managed runtime phase fails.
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        platform: "linux",
        podmanCommand: podmanCommand("podman version 6.0.2"),
        skipSocketProbe: true,
        managedRuntimeSetup: (progress: RuntimeSetupProgress) =>
          progress.run("prerequisites", Effect.fail(failure)),
        eventService: {
          publish: (event) =>
            Effect.sync(() => {
              captured.push(event);
            }),
        },
      }),
    );

    // Then: all declared children settle and task.fail preserves message plus remediation.
    expect(Exit.isFailure(exit)).toBe(true);
    const failed = captured.filter((event) => event._tag === "task.fail");
    expect(failed.map((event) => event.taskId)).toEqual(["prerequisites", "launch", "readiness"]);
    expect(failed[0]?.summary).toBe(failure.message);
    expect(failed[0]?.remediation).toBe(failure.remediation);
    expect(captured.at(-1)).toMatchObject({
      _tag: "task.tree.complete",
      summary: "Lando runtime setup failed",
      succeeded: 1,
      failed: 1,
    });
  });

  test("runs readiness before persisting setup state or reporting the setup tree ready", async () => {
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-readiness-fail-"));
    const readinessError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "setup",
      message: "Runtime did not become ready.",
    });

    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          stateDir,
          readinessCheck: Effect.fail(readinessError),
          eventService: {
            publish: (event) =>
              Effect.sync(() => {
                captured.push(event);
              }),
          },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(existsSync(providerStatePath(stateDir))).toBe(false);

      const treeComplete = captured.find((event) => event._tag === "task.tree.complete");
      expect(treeComplete?.summary).toBe("Lando runtime setup failed");
      expect(treeComplete?.failed).toBe(1);
      expect(captured.some((event) => event.summary === "Lando runtime ready")).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("publishes task.fail and task.tree.complete when the Podman socket is unreachable", async () => {
    const previousSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
    delete process.env.LANDO_TEST_PODMAN_SOCKET;
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "linux",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          eventService: {
            publish: (event) =>
              Effect.sync(() => {
                captured.push(event);
              }),
          },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      const taskFail = captured.find((event) => event._tag === "task.fail");
      expect(taskFail).toBeDefined();
      expect(taskFail?.taskId).toBe("socket");

      const treeComplete = captured.find((event) => event._tag === "task.tree.complete");
      expect(treeComplete).toBeDefined();
      expect(treeComplete?.failed).toBeGreaterThanOrEqual(1);
    } finally {
      if (previousSocket === undefined) {
        // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
        delete process.env.LANDO_TEST_PODMAN_SOCKET;
      } else {
        process.env.LANDO_TEST_PODMAN_SOCKET = previousSocket;
      }
    }
  });

  test("creates and starts the Windows Podman machine when it is missing", async () => {
    const calls: string[] = [];

    await Effect.runPromise(ensureWindowsPodmanMachine(machineRunner("missing", calls)));

    expect(calls).toEqual(["inspect", "create", "start"]);
  });

  test("starts the Windows Podman machine when it is stopped", async () => {
    const calls: string[] = [];

    await Effect.runPromise(ensureWindowsPodmanMachine(machineRunner("stopped", calls)));

    expect(calls).toEqual(["inspect", "start"]);
  });

  test("leaves the Windows Podman machine running when it is already running", async () => {
    const calls: string[] = [];

    await Effect.runPromise(ensureWindowsPodmanMachine(machineRunner("running", calls)));

    expect(calls).toEqual(["inspect"]);
  });

  test("stops, upgrades, and tears down the Windows Podman machine through the fake client", async () => {
    const calls: string[] = [];
    const machine = machineRunner("running", calls);

    await Effect.runPromise(stopWindowsPodmanMachine(machine));
    await Effect.runPromise(upgradeWindowsPodmanMachine(machine));
    await Effect.runPromise(teardownWindowsPodmanMachine(machine));

    expect(calls).toEqual(["stop", "upgrade", "teardown"]);
  });

  test("runs Windows machine setup before validating the Podman API socket", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      setupProviderLando({
        platform: "win32",
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.succeed(undefined),
        },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: machineRunner("missing", calls),
      }),
    );

    expect(calls).toEqual(["inspect", "create", "start"]);
    expect(result.podmanVersion).toBe("6.0.2");
  });

  test("fails with actionable remediation when Windows virtualization prerequisites are missing", async () => {
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        platform: "win32",
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.succeed(undefined),
        },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: {
          ...machineRunner("missing", []),
          create: Effect.fail(
            new WindowsMachinePrerequisiteError({ stderr: "Hyper-V is not enabled on this system" }),
          ),
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(WindowsMachinePrerequisiteError);
        expect(failure.value.remediation).toContain("Hyper-V");
        expect(failure.value.remediation).toContain("WSL2");
        expect(failure.value.remediation).toContain("lando setup");
      }
    }
  });

  test("maps Windows system runner prerequisite stderr to actionable remediation", async () => {
    const fakePodmanDir = await mkdtemp(join(tmpdir(), "lando-provider-windows-podman-"));
    const fakePodman = join(fakePodmanDir, "podman");
    await writeFile(
      fakePodman,
      [
        "#!/usr/bin/env sh",
        'echo "Virtualization support is disabled. Enable Hyper-V, WSL2, and Virtual Machine Platform." >&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    await chmod(fakePodman, 0o755);

    try {
      const exit = await Effect.runPromiseExit(
        makeSystemPodmanMachineRunner(fakePodman, "lando", "win32").create,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(WindowsMachinePrerequisiteError);
          expect(failure.value.remediation).toContain("Hyper-V");
          expect(failure.value.remediation).toContain("WSL2");
          expect(failure.value.remediation).toContain("Virtual Machine Platform");
        }
      }
    } finally {
      await rm(fakePodmanDir, { recursive: true, force: true });
    }
  });

  test("Windows setup task tree includes the machine step", async () => {
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];

    await Effect.runPromise(
      setupProviderLando({
        platform: "win32",
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.succeed(undefined),
        },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: machineRunner("running", []),
        eventService: {
          publish: (event) =>
            Effect.sync(() => {
              captured.push(event);
            }),
        },
      }),
    );

    const treeStart = captured[0];
    expect((treeStart?.children ?? []) as ReadonlyArray<string>).toContain("machine");

    const completedIds = captured
      .filter((event) => event._tag === "task.complete")
      .map((event) => event.taskId as string);
    expect(completedIds).toContain("machine");
  });

  test.skipIf(process.platform !== "win32" || process.env.LANDO_TEST_WINDOWS_PROVIDER_LANDO !== "1")(
    "runs provider-lando Windows machine setup against the host Podman machine",
    async () => {
      await Effect.runPromise(setupProviderLando({ platform: "win32" }));
    },
    120_000,
  );
});

const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, "0")}\0`;

interface TarEntrySpec {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly mode?: number;
  readonly typeflag?: string;
}

const tarHeader = (entry: TarEntrySpec): Uint8Array => {
  const bytes = entry.bytes ?? new Uint8Array();
  const header = new Uint8Array(512);
  header.set(Buffer.from(entry.path, "latin1"), 0);
  header.set(Buffer.from(octal(entry.mode ?? 0o644, 8), "ascii"), 100);
  header.set(Buffer.from(octal(0, 8), "ascii"), 108);
  header.set(Buffer.from(octal(0, 8), "ascii"), 116);
  header.set(Buffer.from(octal(bytes.byteLength, 12), "ascii"), 124);
  header.set(Buffer.from(octal(0, 12), "ascii"), 136);
  header.fill(0x20, 148, 156);
  header[156] = (entry.typeflag ?? "0").charCodeAt(0);
  header.set(Buffer.from("ustar\0", "ascii"), 257);
  header.set(Buffer.from("00", "ascii"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(Buffer.from(octal(checksum, 8), "ascii"), 148);
  return header;
};

const buildTarGz = (entries: ReadonlyArray<TarEntrySpec>): Uint8Array => {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array();
    chunks.push(tarHeader(entry));
    chunks.push(bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
};

const downloaderFor = (archiveBytes: Uint8Array, version = "0.0.0-test") => ({
  download: Effect.succeed({ version, bytes: archiveBytes, sha256: sha256(archiveBytes) }),
});

describe("provider-lando setup runtime bundle extraction", () => {
  test("extracts the verified runtime bundle into runtimeBinDir with executable bits", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-extract-state-"));
    const stateDir = join(root, "providers");
    const runtimeBinDir = join(root, "runtime", "bin");
    const runtimeConfigDir = join(root, "runtime", "config");
    try {
      const archiveBytes = buildTarGz([
        { path: "podman", bytes: new TextEncoder().encode("podman") },
        { path: "gvproxy", bytes: new TextEncoder().encode("gvproxy") },
      ]);
      const result = await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: downloaderFor(archiveBytes),
          stateDir,
          runtimeBinDir,
          runtimeConfigDir,
          socketPath: "/tmp/lando-extract.sock",
        }),
      );

      expect(result.runtimeBinDir).toBe(runtimeBinDir);
      expect(await readFile(join(runtimeConfigDir, "containers.conf"), "utf8")).toContain(
        `helper_binaries_dir = ["${runtimeBinDir}"]`,
      );
      expect(await readFile(join(runtimeConfigDir, "containers", "policy.json"), "utf8")).toBe(`{
  "default": [
    {
      "type": "insecureAcceptAnything"
    }
  ],
  "transports": {
    "docker-daemon": {
      "": [
        {
          "type": "insecureAcceptAnything"
        }
      ]
    }
  }
}
`);
      expect(existsSync(join(runtimeBinDir, "podman"))).toBe(true);
      expect(existsSync(join(runtimeBinDir, "gvproxy"))).toBe(true);
      expect(statSync(join(runtimeBinDir, "podman")).mode & 0o111).not.toBe(0);

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.runtimeBinDir).toBe(runtimeBinDir);
      expect(state.runtimeBundleVersion).toBe("0.0.0-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a verified same-version override before recording its requested SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-extract-override-"));
    const stateDir = join(root, "providers");
    const runtimeBinDir = join(root, "runtime", "bin");
    try {
      const oldArchive = buildTarGz([{ path: "podman", bytes: new TextEncoder().encode("old-podman") }]);
      const newArchive = buildTarGz([{ path: "podman", bytes: new TextEncoder().encode("new-podman") }]);
      const setup = (archiveBytes: Uint8Array) =>
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: downloaderFor(archiveBytes, "1.0.0"),
          stateDir,
          runtimeBinDir,
        });

      await Effect.runPromise(setup(oldArchive));
      await Effect.runPromise(setup(newArchive));

      expect(await readFile(join(runtimeBinDir, "podman"), "utf8")).toBe("new-podman");
      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.runtimeBundleSha256).toBe(sha256(newArchive));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes nothing into runtimeBinDir when the bundle checksum does not match", async () => {
    const runtimeBinDir = join(await mkdtemp(join(tmpdir(), "lando-extract-mismatch-")), "runtime", "bin");
    try {
      const archiveBytes = buildTarGz([{ path: "podman", bytes: new TextEncoder().encode("podman") }]);
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: {
            download: Effect.succeed({ version: "0.0.0-test", bytes: archiveBytes, sha256: "deadbeef" }),
          },
          runtimeBinDir,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderBundleChecksumError);
        }
      }
      expect(existsSync(join(runtimeBinDir, "podman"))).toBe(false);
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("rejects a runtime bundle entry that escapes runtimeBinDir with remediation", async () => {
    const runtimeBinDir = join(await mkdtemp(join(tmpdir(), "lando-extract-traversal-")), "runtime", "bin");
    try {
      const archiveBytes = buildTarGz([{ path: "../escape", bytes: new TextEncoder().encode("evil") }]);
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: downloaderFor(archiveBytes),
          runtimeBinDir,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect((failure.value as ProviderUnavailableError).remediation).toBeDefined();
        }
      }
      expect(existsSync(runtimeBinDir)).toBe(false);
      expect(existsSync(join(runtimeBinDir, "..", "escape"))).toBe(false);
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("is version-idempotent and replaces the bin tree atomically on a version change", async () => {
    const runtimeBinDir = join(await mkdtemp(join(tmpdir(), "lando-extract-idem-")), "runtime", "bin");
    try {
      const v1 = buildTarGz([
        { path: "podman", bytes: new TextEncoder().encode("podman") },
        { path: "old-only", bytes: new TextEncoder().encode("old") },
      ]);
      const setupV1 = () =>
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: downloaderFor(v1, "1.0.0"),
          runtimeBinDir,
        });

      await Effect.runPromise(setupV1());
      const markerPath = join(runtimeBinDir, ".runtime-installed-version");
      expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
        version: "1.0.0",
        sha256: sha256(v1),
      });
      const firstMtime = statSync(markerPath).mtimeMs;

      await Effect.runPromise(setupV1());
      expect(statSync(markerPath).mtimeMs).toBe(firstMtime);
      expect(existsSync(join(runtimeBinDir, "old-only"))).toBe(true);

      const v2 = buildTarGz([
        { path: "podman", bytes: new TextEncoder().encode("podman") },
        { path: "new-only", bytes: new TextEncoder().encode("new") },
      ]);
      await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: downloaderFor(v2, "2.0.0"),
          runtimeBinDir,
        }),
      );

      expect(existsSync(join(runtimeBinDir, "old-only"))).toBe(false);
      expect(existsSync(join(runtimeBinDir, "new-only"))).toBe(true);
      expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
        version: "2.0.0",
        sha256: sha256(v2),
      });
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("does not record runtimeBinDir in setup state when no bin dir is provided", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-extract-nobin-"));
    try {
      const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
      await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          podmanApi: {
            info: Effect.succeed({ version: { Version: "6.0.2" } }),
            ping: Effect.succeed(undefined),
          },
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBundleDownloader: downloaderFor(bundleBytes),
          stateDir,
          socketPath: "/tmp/lando-nobin.sock",
        }),
      );

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect("runtimeBinDir" in state).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
