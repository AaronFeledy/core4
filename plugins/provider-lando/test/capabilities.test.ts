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
    const expectedFields = Object.keys(ProviderCapabilities.fields).sort();
    const linux = mvpProviderCapabilities("linux");
    const macos = mvpProviderCapabilities("darwin");
    const windows = mvpProviderCapabilities("win32");

    expect(Object.keys(linux).sort()).toEqual(expectedFields);
    expect(Object.keys(macos).sort()).toEqual(expectedFields);
    expect(Object.keys(windows).sort()).toEqual(expectedFields);
    expect(linux.bindMountPerformance).toBe("native");
    expect(macos.bindMountPerformance).toBe("slow");
    expect(windows.bindMountPerformance).toBe("slow");
    expect(linux.sharedCrossAppNetwork).toBe(true);
    expect(macos.sharedCrossAppNetwork).toBe(true);
    expect(windows.sharedCrossAppNetwork).toBe(true);
  });

  test("does not advertise host-proxy container targets without runtime API introspection", () => {
    expect(linuxMvpCapabilities.providerExtensions).not.toContain(
      "@lando/core/host-proxy-container-target:linux-x64",
    );
    expect(macosMvpCapabilities.providerExtensions).not.toContain(
      "@lando/core/host-proxy-container-target:linux-arm64",
    );
    expect(
      mvpProviderCapabilities("win32").providerExtensions.some((extension) =>
        extension.startsWith("@lando/core/host-proxy-container-target:"),
      ),
    ).toBe(false);
  });

  test("declares the Linux ProviderCapabilities through the Live Layer", async () => {
    const layer = makeProviderLayer({
      platform: "linux",
      podmanApi: { info: Effect.succeed({ host: { arch: "x64" } }), ping: Effect.succeed(undefined) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities).toEqual({
      ...linuxMvpCapabilities,
      providerExtensions: ["@lando/core/host-proxy-container-target:linux-x64"],
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
      providerExtensions: ["@lando/core/host-proxy-container-target:linux-arm64"],
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
      ...mvpProviderCapabilities("win32"),
      serviceLogSources: false,
    });
    expect(runtimeProvider.capabilities.bindMounts).toBe(true);
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe("slow");
    expect(runtimeProvider.capabilities.providerExtensions).toEqual([
      "@lando/core/host-proxy-transport:tcp-host-gateway:host.containers.internal",
    ]);
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

    expect(runtimeProvider.capabilities.providerExtensions).toContain(
      "@lando/core/host-proxy-container-target:linux-arm64",
    );
    expect(runtimeProvider.capabilities.providerExtensions).not.toContain(
      "@lando/core/host-proxy-container-target:linux-x64",
    );
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

    expect(
      runtimeProvider.capabilities.providerExtensions.some((extension) =>
        extension.startsWith("@lando/core/host-proxy-container-target:"),
      ),
    ).toBe(false);
  });

  test("introspects managed providerSocketPath API architecture for registry construction", async () => {
    const runtimeProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            providerSocketPath: "/tmp/lando-managed-podman.sock",
            podmanApiFactory: (socketPath) => {
              expect(socketPath).toBe("/tmp/lando-managed-podman.sock");
              return { info: Effect.succeed({ host: { arch: "aarch64" } }), ping: Effect.succeed(undefined) };
            },
          }),
        ),
      ),
    );

    expect(runtimeProvider.capabilities.providerExtensions).toContain(
      "@lando/core/host-proxy-container-target:linux-arm64",
    );
  });

  test("ensures managed providerSocketPath runtime before capability introspection", async () => {
    const calls: string[] = [];
    let ready = false;
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
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

    expect(calls.indexOf("launch")).toBeGreaterThan(-1);
    expect(calls.indexOf("info")).toBeGreaterThan(calls.indexOf("launch"));
    expect(provider.capabilities.providerExtensions).toContain(
      "@lando/core/host-proxy-container-target:linux-arm64",
    );
  });

  test("advertises Podman Desktop host alias for Windows TCP transport", () => {
    expect(mvpProviderCapabilities("win32").providerExtensions).toContain(
      "@lando/core/host-proxy-transport:tcp-host-gateway:host.containers.internal",
    );
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
