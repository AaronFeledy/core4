import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { sha256Hex } from "@lando/sdk/digest";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import { makeRuntimeProvider } from "../src/index.ts";
import { buildPodmanServiceArgs } from "../src/podman-service-args.ts";
import { type PodmanMachineRunner, makeSystemPodmanMachineRunner, setupProviderLando } from "../src/setup.ts";
import {
  LEGACY_NATIVE_INIT_BRIDGE_VERSION,
  catatonitFixture,
  singleFileTarGz,
} from "./fixtures/catatonit.ts";

const withRuntime = async (run: (paths: ReturnType<typeof runtimePaths>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-init-ready-"));
  const paths = runtimePaths(root);
  try {
    await mkdir(paths.runRoot, { recursive: true });
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const runtimePaths = (root: string) => ({
  root,
  podmanBin: join(root, "bin", "podman"),
  runtimeBinDir: join(root, "bin"),
  storageDir: join(root, "storage"),
  runRoot: join(root, "run"),
  configDir: join(root, "config"),
  socketPath: join(root, "run", "podman.sock"),
  pidPath: join(root, "run", "podman.pid"),
});

describe("managed native init readiness", () => {
  test("direct setup never publishes init_path before helper provisioning succeeds", () =>
    withRuntime(async (paths) => {
      const result = await Effect.runPromise(
        Effect.result(
          setupProviderLando({
            platform: "linux",
            runtimeBinDir: paths.runtimeBinDir,
            runtimeConfigDir: paths.configDir,
            podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
            artifactDownload: () =>
              Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "setup",
                  message: "fixture download failed",
                  remediation: "retry",
                }),
              ),
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(existsSync(join(paths.configDir, "containers.conf"))).toBe(false);
    }));
  test("setup re-provisions native init after replacing the published-bundle layout", () =>
    withRuntime(async (paths) => {
      const fixture = catatonitFixture();
      const archive = singleFileTarGz(Buffer.from("podman"), "podman");
      const version = LEGACY_NATIVE_INIT_BRIDGE_VERSION;
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          sanitizeAppliedPlan: stripHostProxyRunLando,
          platform: "linux",
          arch: "x64",
          runtimeBinDir: paths.runtimeBinDir,
          runtimeConfigDir: paths.configDir,
          runtimeRunDir: paths.runRoot,
          runtimeStorageDir: paths.storageDir,
          providerSocketPath: paths.socketPath,
          providerPidPath: paths.pidPath,
          podmanApi: { ping: Effect.void, info: Effect.succeed({ version: { Version: "6.0.2" } }) },
          podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
          runtimeBundleDownloader: {
            download: Effect.sync(() => ({ bytes: archive, sha256: sha256Hex(archive), version })),
          },
          artifactDownload: fixture.download,
          _catatonitPackage: fixture.pkg,
          podmanService: {
            launch: () => Effect.succeed(4567),
            isAlive: () => Effect.succeed(true),
            isServiceProcess: () => Effect.succeed(true),
            terminate: () => Effect.void,
          },
          rootlessProbes: {
            probe: () => ({
              subidConfigured: true,
              subidRangeSufficient: true,
              subidRangesDisjoint: true,
              hasUidmapTools: true,
              cgroupsV2Delegated: true,
              hasXdgRuntimeDir: true,
            }),
          },
        }),
      );
      const plan = await Effect.runPromise(provider.planSetup({ force: false }));
      await Effect.runPromise(Effect.scoped(provider.setup(plan, { force: false })));
      // Simulate published-bundle replace wiping helper while keeping the bridge identity.
      await rm(join(paths.runtimeBinDir, "catatonit"));
      await writeFile(
        join(paths.runtimeBinDir, ".runtime-installed-version"),
        `${LEGACY_NATIVE_INIT_BRIDGE_VERSION}\n`,
      );
      await Effect.runPromise(Effect.scoped(provider.setup(plan, { force: false })));
      expect(new Uint8Array(await readFile(join(paths.runtimeBinDir, "catatonit")))).toEqual(
        new Uint8Array(fixture.elf),
      );
      expect(fixture.downloads()).toBe(3);
      expect(await readFile(join(paths.runtimeBinDir, ".runtime-installed-version"), "utf8")).toContain(
        LEGACY_NATIVE_INIT_BRIDGE_VERSION,
      );
    }));

  for (const platform of ["linux", "darwin", "win32"] as const) {
    for (const machineRunner of ["default", "injected"] as const) {
      test(`${platform} external sockets ignore ${machineRunner} managed machine setup`, () =>
        withRuntime(async (paths) => {
          const forbidden = Effect.die("external setup must not access a managed machine");
          const machine: PodmanMachineRunner = {
            inspect: forbidden,
            create: forbidden,
            start: forbidden,
            stop: forbidden,
            upgrade: forbidden,
            teardown: forbidden,
            verifyNativeInit: forbidden,
            syncTrust: forbidden,
            activateApiSocket: forbidden,
            createdAt: forbidden,
          };
          const provider = await Effect.runPromise(
            makeRuntimeProvider({
              sanitizeAppliedPlan: stripHostProxyRunLando,
              platform,
              arch: platform === "darwin" ? "arm64" : "x64",
              ...(machineRunner === "injected" ? { podmanMachine: machine } : {}),
              socketPath: join(paths.root, "external.sock"),
              runtimeBinDir: paths.runtimeBinDir,
              runtimeConfigDir: paths.configDir,
              runtimeStorageDir: paths.storageDir,
              runtimeRunDir: paths.runRoot,
              providerSocketPath: paths.socketPath,
              providerPidPath: paths.pidPath,
              podmanApi: { ping: Effect.void, info: Effect.succeed({ version: { Version: "6.0.2" } }) },
              podmanCommand: { version: Effect.die("external setup must not require a host Podman CLI") },
              rootlessProbes: {
                probe: () => {
                  throw new Error("external setup must not inspect host prerequisites");
                },
              },
              artifactDownload: () => Effect.die("must not provision against an external socket"),
              runtimeBundleDownloader: { download: Effect.die("must not replace local runtime") },
              podmanService: {
                launch: () => Effect.die("must not launch"),
                isAlive: () => Effect.die("must not guess"),
                terminate: () => Effect.die("must not terminate"),
              },
            }),
          );
          const plan = await Effect.runPromise(provider.planSetup({ force: false }));
          await Effect.runPromise(Effect.scoped(provider.setup(plan, { force: false })));
          expect(await readdir(paths.root)).toEqual(["run"]);
        }));
    }
  }
  test("repairs helper and config under the lock before reusing a warm owned daemon", () =>
    withRuntime(async (paths) => {
      const fixture = catatonitFixture();
      let locked = false;
      const spec = buildPodmanServiceArgs(paths);
      await writeFile(paths.pidPath, "4321");
      await writeFile(`${paths.pidPath}.launch.json`, JSON.stringify({ pid: 4321, env: spec.env }));
      await mkdir(paths.configDir);
      await writeFile(join(paths.configDir, "containers.conf"), "broken");
      await mkdir(paths.runtimeBinDir, { recursive: true });
      await writeFile(
        join(paths.runtimeBinDir, ".runtime-installed-version"),
        `${LEGACY_NATIVE_INIT_BRIDGE_VERSION}\n`,
      );
      await Effect.runPromise(
        ensureRuntime({
          ...paths,
          platform: "linux",
          catatonitProvision: {
            runtimeBinDir: paths.runtimeBinDir,
            cacheDir: paths.root,
            package: fixture.pkg,
            arch: "x64",
            download: (request) =>
              Effect.suspend(() => {
                expect(locked).toBe(true);
                return fixture.download(request);
              }),
          },
          podmanApi: {
            info: Effect.succeed({}),
            ping: Effect.promise(async () => {
              expect(locked).toBe(true);
              expect(new Uint8Array(await readFile(join(paths.runtimeBinDir, "catatonit")))).toEqual(
                new Uint8Array(fixture.elf),
              );
              const config = Bun.TOML.parse(await readFile(join(paths.configDir, "containers.conf"), "utf8"));
              expect(config).toHaveProperty("containers.init_path", join(paths.runtimeBinDir, "catatonit"));
            }),
          },
          serviceRunner: {
            launch: () => Effect.die("must reuse warm daemon"),
            isAlive: () => Effect.succeed(true),
            isServiceProcess: () => Effect.succeed(true),
            terminate: () => Effect.die("must not terminate"),
          },
          withLaunchLock: (body) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                locked = true;
              }),
              () => body,
              () =>
                Effect.sync(() => {
                  locked = false;
                }),
            ),
        }),
      );
      expect(fixture.downloads()).toBe(2);
      expect(await readFile(paths.pidPath, "utf8")).toBe("4321");
    }));

  test("relaunches only the old owned API daemon and preserves live runroot on upgrade", () =>
    withRuntime(async (paths) => {
      const fixture = catatonitFixture();
      const { LANDO_MANAGED_CONFIG_REVISION: _revision, ...oldEnv } = buildPodmanServiceArgs(paths).env ?? {};
      await writeFile(paths.pidPath, "4321");
      await writeFile(`${paths.pidPath}.launch.json`, JSON.stringify({ pid: 4321, env: oldEnv }));
      await mkdir(paths.runtimeBinDir, { recursive: true });
      await writeFile(
        join(paths.runtimeBinDir, ".runtime-installed-version"),
        `${LEGACY_NATIVE_INIT_BRIDGE_VERSION}\n`,
      );
      const sentinel = join(paths.runRoot, "container-state");
      await writeFile(sentinel, "preserve");
      let marker: string | null = null;
      let alive = true;
      const actions: string[] = [];
      const deps = {
        ...paths,
        platform: "linux" as const,
        catatonitProvision: {
          runtimeBinDir: paths.runtimeBinDir,
          cacheDir: paths.root,
          package: fixture.pkg,
          arch: "x64",
          download: fixture.download,
        },
        podmanApi: { info: Effect.succeed({}), ping: Effect.void },
        serviceRunner: {
          launch: () =>
            Effect.sync(() => {
              actions.push("launch");
              alive = true;
              return 5678;
            }),
          isAlive: () => Effect.sync(() => alive),
          isServiceProcess: () => Effect.succeed(true),
          terminate: (pid: number) =>
            Effect.sync(() => {
              actions.push(`terminate:${pid}`);
              alive = false;
            }),
        },
        generationStore: {
          get: Effect.sync(() => marker),
          set: (value: string) =>
            Effect.sync(() => {
              marker = value;
            }),
        },
        bootIdReader: () => Effect.succeed("boot-current"),
        pidNamespaceReader: () => Effect.succeed("pid:[1]"),
      };
      await Effect.runPromise(ensureRuntime(deps));
      expect(actions).toEqual(["terminate:4321", "launch"]);
      expect(await readFile(sentinel, "utf8")).toBe("preserve");
      expect<string | null>(marker).toBe("boot-current\npid:[1]");
      await Effect.runPromise(ensureRuntime(deps));
      expect(actions).toEqual(["terminate:4321", "launch"]);
      expect(fixture.downloads()).toBe(2);
    }));

  for (const platform of ["darwin", "win32"] as const) {
    test.each([true, false])(
      `${platform} guest native init preparation is operation-aware: %s`,
      (prepareNativeInit) =>
        withRuntime(async (paths) => {
          let probes = 0;
          const machine: PodmanMachineRunner = {
            inspect: Effect.succeed("running"),
            create: Effect.die("not create"),
            start: Effect.die("not start"),
            stop: Effect.die("not stop"),
            upgrade: Effect.void,
            teardown: Effect.void,
            verifyNativeInit: Effect.sync(() => {
              probes++;
            }),
          };
          await Effect.runPromise(
            ensureRuntime({
              ...paths,
              platform,
              arch: "arm64",
              machineRunner: machine,
              prepareNativeInit,
              podmanApi: { ping: Effect.void, info: Effect.succeed({}) },
              serviceRunner: {
                launch: () => Effect.die("host launch"),
                isAlive: () => Effect.die("host check"),
                terminate: () => Effect.die("host terminate"),
              },
              catatonitProvision: {
                runtimeBinDir: paths.runtimeBinDir,
                cacheDir: paths.root,
                download: () => Effect.die("host download"),
              },
            }),
          );
          expect(probes).toBe(prepareNativeInit ? 1 : 0);
        }),
    );

    test(`${platform} invokes the machine image helper through its guest seam`, async () => {
      const calls: ReadonlyArray<string>[] = [];
      const runner = makeSystemPodmanMachineRunner("/host/bin/podman", "lando", platform, (argv) => {
        calls.push(argv);
        return { stdout: new Response("catatonit 0.2.1").body, stderr: null, exited: Promise.resolve(0) };
      });
      if (runner.verifyNativeInit === undefined) throw new Error("guest readiness missing");
      await Effect.runPromise(runner.verifyNativeInit);
      expect(calls).toEqual([
        platform === "win32"
          ? [
              "wsl.exe",
              "--distribution",
              "podman-lando",
              "--user",
              "root",
              "--exec",
              "/usr/libexec/podman/catatonit",
              "--version",
            ]
          : ["/host/bin/podman", "machine", "ssh", "lando", "/usr/libexec/podman/catatonit", "--version"],
      ]);
    });
  }
});
