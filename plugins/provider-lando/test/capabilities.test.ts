import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  decodeProviderCapabilities,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  macosMvpCapabilities,
  makePodmanInfoRequest,
  makePodmanPingRequest,
  makeProviderLayer,
  mvpProviderCapabilities,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import { ProviderCapabilities } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

describe("provider-lando capabilities", () => {
  test("declares every ProviderCapabilities field for Linux and macOS", () => {
    const expectedFields = Object.keys(ProviderCapabilities.fields)
      .filter((field) => field !== "hostProxy")
      .sort();
    const expectedWindowsFields = Object.keys(ProviderCapabilities.fields).sort();
    const linux = mvpProviderCapabilities("linux");
    const macos = mvpProviderCapabilities("darwin");
    const windows = mvpProviderCapabilities("win32");

    expect(Object.keys(linux).sort()).toEqual(expectedFields);
    expect(Object.keys(macos).sort()).toEqual(expectedFields);
    expect(Object.keys(windows).sort()).toEqual(expectedWindowsFields);
    expect(linux.bindMountPerformance).toBe("native");
    expect(macos.bindMountPerformance).toBe("slow");
    expect(windows.bindMountPerformance).toBe("slow");
    expect(linux.sharedCrossAppNetwork).toBe(true);
    expect(macos.sharedCrossAppNetwork).toBe(true);
    expect(windows.sharedCrossAppNetwork).toBe(true);
    expect(linux.artifactBuild).toBe(true);
    expect(macos.artifactBuild).toBe(true);
    expect(windows.artifactBuild).toBe(true);
  });

  test("does not advertise host-proxy container targets without runtime API introspection", () => {
    expect(linuxMvpCapabilities.hostProxy).toBeUndefined();
    expect(macosMvpCapabilities.hostProxy).toBeUndefined();
    expect(mvpProviderCapabilities("win32").hostProxy?.containerTargets).toEqual([]);
  });

  test("does not advertise artifact builds without a Podman API client", async () => {
    const runtimeProvider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux" }))),
    );
    expect(runtimeProvider.capabilities.artifactBuild).toBe(false);
    expect(runtimeProvider.capabilities.artifactPull).toBe(false);
  });

  test("advertises artifact pull only when a Podman API client is wired", async () => {
    const runtimeProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            podmanApi: { info: Effect.succeed({ host: { arch: "x64" } }), ping: Effect.succeed(undefined) },
          }),
        ),
      ),
    );

    expect(runtimeProvider.capabilities.artifactPull).toBe(true);
  });

  test("declares the Linux ProviderCapabilities through the Live Layer", async () => {
    const layer = makeProviderLayer({
      platform: "linux",
      podmanApi: { info: Effect.succeed({ host: { arch: "x64" } }), ping: Effect.succeed(undefined) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities).toEqual({
      ...linuxMvpCapabilities,
      hostProxy: { containerTargets: [{ os: "linux", arch: "x64" }] },
      serviceLogSources: false,
    });
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe(
      mvpProviderCapabilities("linux").bindMountPerformance,
    );
    expect(runtimeProvider.capabilities.sharedCrossAppNetwork).toBe(true);
    expect(runtimeProvider.capabilities.copyMounts).toBe(false);
    expect(Object.keys(runtimeProvider.capabilities).sort()).toEqual(
      Object.keys(ProviderCapabilities.fields).sort(),
    );
  });

  test("advertises service log source following only when file access is injected", async () => {
    const fs = makeMemoryLogFileAccess();
    const layer = makeProviderLayer({
      platform: "linux",
      podmanApi: { info: Effect.succeed({ host: { arch: "x64" } }), ping: Effect.succeed(undefined) },
      logFileAccess: fs.access,
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities.serviceLogSources).toBe(true);
  });

  test("advertises service log source following when a helper payload matches Podman info architecture", async () => {
    const layer = makeProviderLayer({
      platform: "linux",
      podmanApi: { info: Effect.succeed({ host: { arch: "x86_64" } }), ping: Effect.succeed(undefined) },
      logFileHelperPayloads: { "linux-x64": new Uint8Array([1, 2, 3]) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities.serviceLogSources).toBe(true);
  });

  test("does not advertise service log source following when Podman info architecture has no helper payload", async () => {
    const layer = makeProviderLayer({
      platform: "linux",
      podmanApi: { info: Effect.succeed({ host: { arch: "aarch64" } }), ping: Effect.succeed(undefined) },
      logFileHelperPayloads: { "linux-x64": new Uint8Array([1, 2, 3]) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities.serviceLogSources).toBe(false);
  });

  test("declares macOS support with slow bind mount performance", async () => {
    const layer = makeProviderLayer({
      platform: "darwin",
      arch: "arm64",
      podmanApi: { info: Effect.succeed({ host: { arch: "arm64" } }), ping: Effect.succeed(undefined) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.platform).toBe("darwin");
    expect(runtimeProvider.capabilities).toEqual({
      ...macosMvpCapabilities,
      hostProxy: { containerTargets: [{ os: "linux", arch: "arm64" }] },
      serviceLogSources: false,
    });
    expect(runtimeProvider.capabilities.bindMounts).toBe(true);
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe("slow");
  });

  test("declares Windows support with slow bind mount performance", async () => {
    const layer = makeProviderLayer({ platform: "win32", arch: "arm64" });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.platform).toBe("win32");
    expect(runtimeProvider.capabilities).toEqual({
      ...mvpProviderCapabilities("win32", "arm64"),
      artifactBuild: false,
      artifactPull: false,
      serviceLogSources: false,
    });
    expect(runtimeProvider.capabilities.bindMounts).toBe(true);
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe("slow");
    expect(runtimeProvider.capabilities.providerExtensions).toEqual([]);
    expect(runtimeProvider.capabilities.hostProxy).toEqual({
      containerTargets: [{ os: "linux", arch: "arm64" }],
      tcpHostGateway: "host.containers.internal",
    });
  });

  test("uses Podman info architecture over injected host architecture", async () => {
    const runtimeProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            arch: "x64",
            podmanApi: { info: Effect.succeed({ host: { arch: "arm64" } }), ping: Effect.succeed(undefined) },
          }),
        ),
      ),
    );

    expect(runtimeProvider.capabilities.hostProxy?.containerTargets).toEqual([
      { os: "linux", arch: "arm64" },
    ]);
  });

  test("omits host-proxy container targets when Podman info omits architecture despite injected host architecture", async () => {
    const runtimeProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            arch: "arm64",
            podmanApi: { info: Effect.succeed({ host: {} }), ping: Effect.succeed(undefined) },
          }),
        ),
      ),
    );

    expect(runtimeProvider.capabilities.hostProxy).toBeUndefined();
  });

  test("uses injected architecture without probing a cold managed runtime during registry construction", async () => {
    const calls: string[] = [];
    const runtimeProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            arch: "arm64",
            providerSocketPath: "/tmp/lando-managed-podman.sock",
            podmanApiFactory: (socketPath) => {
              expect(socketPath).toBe("/tmp/lando-managed-podman.sock");
              return {
                info: Effect.sync(() => {
                  calls.push("info");
                  return { host: { arch: "x86_64" } };
                }),
                ping: Effect.succeed(undefined),
              };
            },
          }),
        ),
      ),
    );

    expect(runtimeProvider.capabilities.hostProxy?.containerTargets).toEqual([
      { os: "linux", arch: "arm64" },
    ]);
    expect(calls).toEqual([]);
  });

  test("does not launch a managed runtime while resolving provider capabilities", async () => {
    const calls: string[] = [];
    let ready = false;
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            arch: "arm64",
            providerSocketPath: "/tmp/lando-managed-cold.sock",
            providerPidPath: "/tmp/lando-managed-cold.pid",
            runtimeStorageDir: "/tmp/lando-managed-storage",
            runtimeRunDir: "/tmp/lando-managed-run",
            runtimeConfigDir: "/tmp/lando-managed-config",
            podmanService: {
              launch: () =>
                Effect.sync(() => {
                  calls.push("launch");
                  ready = true;
                  return 1234;
                }),
              isAlive: () => Effect.succeed(false),
              terminate: () => Effect.void,
            },
            podmanApiFactory: () => ({
              ping: Effect.gen(function* () {
                yield* Effect.sync(() => calls.push("ping"));
                if (!ready) {
                  return yield* Effect.fail(
                    new ProviderUnavailableError({
                      providerId: "lando",
                      operation: "ping",
                      message: "cold socket",
                      remediation: "test only",
                    }),
                  );
                }
              }),
              info: Effect.gen(function* () {
                yield* Effect.sync(() => calls.push("info"));
                if (!ready) {
                  return yield* Effect.fail(
                    new ProviderUnavailableError({
                      providerId: "lando",
                      operation: "info",
                      message: "info called before runtime launch",
                      remediation: "test only",
                    }),
                  );
                }
                return { host: { arch: "aarch64" } };
              }),
            }),
          }),
        ),
      ),
    );

    expect(calls).toEqual([]);
    expect(provider.capabilities.hostProxy?.containerTargets).toEqual([{ os: "linux", arch: "arm64" }]);
  });

  test("advertises Podman Desktop host alias for Windows TCP transport", () => {
    expect(mvpProviderCapabilities("win32").hostProxy).toEqual({
      containerTargets: [],
      tcpHostGateway: "host.containers.internal",
    });
  });

  test("builds Podman API HTTP-over-UNIX requests without invoking the podman binary", () => {
    const request = makePodmanInfoRequest("/tmp/podman.sock");

    expect(request.command).toBe("curl");
    expect(request.command).not.toBe("podman");
    expect(request.socketUrl).toBe("unix:///tmp/podman.sock");
    expect(request.args).toContain("--unix-socket");
    expect(request.args).toContain("/tmp/podman.sock");
    expect(request.args).toContain("http://localhost/v6.0.0/libpod/info");
  });

  test("builds cheap Podman API ping requests without invoking capability detection", () => {
    const request = makePodmanPingRequest("/tmp/podman.sock");

    expect(request.command).toBe("curl");
    expect(request.command).not.toBe("podman");
    expect(request.socketUrl).toBe("unix:///tmp/podman.sock");
    expect(request.args).toContain("--unix-socket");
    expect(request.args).toContain("/tmp/podman.sock");
    expect(request.args).toContain("http://localhost/v6.0.0/libpod/_ping");
    expect(request.args).not.toContain("http://localhost/v6.0.0/libpod/info");
  });

  test("decodes capabilities through the SDK schema", async () => {
    const capabilities = await Effect.runPromise(
      introspectProviderCapabilities({ info: Effect.succeed({}), ping: Effect.succeed(undefined) }, "linux"),
    );

    expect(capabilities).toEqual(mvpProviderCapabilities("linux"));
  });

  test("invalid capability payload fails with ProviderCapabilityError", async () => {
    const exit = await Effect.runPromiseExit(
      decodeProviderCapabilities({ ...linuxMvpCapabilities, bindMountPerformance: "fast" }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("ProviderCapabilityError");
    }
  });
});
