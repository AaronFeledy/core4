import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import {
  PodmanMachinePrerequisiteError,
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  ProviderBundleChecksumError,
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
import type { PodmanMachineRunner, PodmanMachineStatus } from "../src/setup.ts";

const podmanCommand = (version: string) => ({ version: Effect.succeed(version) });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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
        setupProviderLando({ podmanCommand: podmanCommand("podman version 5.2.0") }),
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
            podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
            podmanCommand: podmanCommand("podman version 5.2.0"),
            runtimeBundleDownloader: {
              download: Effect.succeed({
                version: "0.0.0-test",
                bytes: bundleBytes,
                sha256: sha256(bundleBytes),
              }),
            },
            stateDir,
          }),
        ),
      ),
    );

    try {
      await Effect.runPromise(Effect.scoped(provider.setup({ force: false })));

      const versions = await Effect.runPromise(provider.getVersions);
      expect(versions.runtime).toBe("5.2.0");

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state).toEqual({
        podmanVersion: "5.2.0",
        runtimeBundleVersion: "0.0.0-test",
        runtimeBundleSha256: sha256(bundleBytes),
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
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
        podmanMachine: machineRunner("missing", calls),
      }),
    );

    expect(calls).toEqual(["inspect", "create", "start"]);
    expect(result.podmanVersion).toBe("5.2.0");
  });

  test("fails with actionable remediation when macOS machine prerequisites are missing", async () => {
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        platform: "darwin",
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
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
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
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
        expect(failure.value.remediation).toContain("§5.8.1");
      }
    }
  });

  test("wires the default runtime-bundle downloader when provider setup has a state directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-default-bundle-"));
    const calls: string[] = [];
    let fetchedUrl: string | undefined;
    const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
      fetchedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(new Response(new TextEncoder().encode("tampered windows runtime bundle")));
    }) as typeof fetch;

    try {
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "win32",
          podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
          podmanCommand: podmanCommand("podman version 5.2.0"),
          podmanMachine: machineRunner("running", calls),
          runtimeBundleFetchImpl: fetchImpl,
          stateDir,
        }),
      );

      const exit = await Effect.runPromiseExit(provider.setup({ force: false }));

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
          podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
          podmanCommand: podmanCommand("podman version 5.2.0"),
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

  test("publishes task.fail and task.tree.complete when the Podman socket is unreachable", async () => {
    const previousSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
    delete process.env.LANDO_TEST_PODMAN_SOCKET;
    const captured: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "linux",
          podmanCommand: podmanCommand("podman version 5.2.0"),
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
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
        podmanMachine: machineRunner("missing", calls),
      }),
    );

    expect(calls).toEqual(["inspect", "create", "start"]);
    expect(result.podmanVersion).toBe("5.2.0");
  });

  test("fails with actionable remediation when Windows virtualization prerequisites are missing", async () => {
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        platform: "win32",
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
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
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
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
