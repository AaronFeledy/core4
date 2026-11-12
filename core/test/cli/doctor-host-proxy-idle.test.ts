import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { hostProxyTransportDoctorChecks } from "../../src/cli/commands/doctor-host-proxy.ts";
import { HostProxyDoctorFileSystem } from "../../src/cli/commands/doctor-host-proxy-filesystem.ts";
import { diagnoseHostProxyWorker } from "../../src/cli/commands/doctor-host-proxy-worker.ts";

test.each([
  { idle: true, privateDirectory: true, status: "pass" },
  { idle: true, privateDirectory: false, status: "warn" },
  { idle: false, privateDirectory: true, status: "warn" },
])(
  "idle=$idle retains privacy=$privateDirectory while diagnosing host-proxy reachability",
  async ({ idle, privateDirectory, status }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-doctor-worker-"));
    try {
      let inspections = 0;
      const result = await Effect.runPromise(
        diagnoseHostProxyWorker({
          current: false,
          maxProbeServices: 1,
          record: {
            appId: "test",
            transport: "unix-socket",
            socketPath: join(root, "absent.sock"),
            protocolVersion: 3,
            pid: process.pid,
            controlToken: "test-only",
          },
          doctor: {
            provider: TestRuntimeProvider,
            providerKind: "managed",
            runtimeIdle: idle,
            runtimeStatus: idle ? "idle (starts on demand)" : "running",
            runtime: { running: !idle },
            selection: { providerId: "lando", source: "default", inputs: { capabilityDefault: "lando" } },
          },
        }).pipe(
          Effect.provideService(
            HostProxyDoctorFileSystem,
            HostProxyDoctorFileSystem.of({
              readRoot: () => Effect.die("not used"),
              socketMetadata: (path) =>
                Effect.sync(() => {
                  inspections += 1;
                  return path === root
                    ? {
                        type: "directory" as const,
                        mode: privateDirectory ? 0o700 : 0o755,
                        owned: true,
                        privateDirectory,
                      }
                    : undefined;
                }),
            }),
          ),
        ),
      );
      expect(inspections).toBe(2);
      expect(result.status).toBe(status);
      if (idle && result.status !== "skipped") {
        expect(result.name).toBe("host-proxy-privacy");
        expect(result.context.privateRunDirectory).toBe(String(privateDirectory));
        expect(result.context.reachability).toBe("skipped");
        expect(result.solutions).toHaveLength(privateDirectory ? 0 : 1);
      } else {
        if (result.status === "skipped") throw new Error("privacy inspection must be reported");
        expect(result.solutions).toHaveLength(1);
        expect(result.solutions[0]?.command).toBe("lando start");
        expect(result.solutions[0]?.description).toContain(
          privateDirectory ? "worker is not running" : "ownership",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("idle report exposes host privacy and separately skips reachability without contacting the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-idle-privacy-"));
  const paths = makeLandoPaths({ userDataRoot: root, platform: "linux", env: {} });
  const runDir = join(paths.hostProxyRunRoot, "legacy-demo");
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(runDir, "worker.json"),
      JSON.stringify({
        appId: "legacy-demo",
        transport: "unix-socket",
        socketPath: join(runDir, "absent.sock"),
        shimPath: join(runDir, "lando"),
        protocolVersion: 1,
        startedAt: "2026-07-15T00:00:00.000Z",
        pid: process.pid,
        controlToken: "private-control",
      }),
    );
    const result = await Effect.runPromise(
      hostProxyTransportDoctorChecks({
        provider: TestRuntimeProvider,
        providerKind: "managed",
        runtimeIdle: true,
        runtimeStatus: "idle (starts on demand)",
        runtime: { running: false },
        selection: { providerId: "lando", source: "default", inputs: { capabilityDefault: "lando" } },
        sourceEnv: {},
      }).pipe(Effect.provide(HostProxyDoctorFileSystem.layer), Effect.provideService(PathsService, paths)),
    );
    expect(
      result.checks.filter(
        (check) => check.name.startsWith("host-proxy-") && check.name !== "host-proxy-allowlist",
      ),
    ).toMatchObject([
      {
        name: "host-proxy-privacy",
        status: "pass",
        context: { privateRunDirectory: "true", reachability: "skipped" },
      },
    ]);
    expect(result.skipped).toEqual([
      {
        section: "host-proxy-transport:legacy-demo",
        status: "skipped",
        reason: "Provider test is idle; host-proxy reachability was not probed.",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
