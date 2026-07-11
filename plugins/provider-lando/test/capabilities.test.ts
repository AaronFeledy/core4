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

  test("declares the Linux ProviderCapabilities through the Live Layer", async () => {
    const layer = makeProviderLayer({
      platform: "linux",
      podmanApi: { info: Effect.succeed({}), ping: Effect.succeed(undefined) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities).toEqual({ ...linuxMvpCapabilities, serviceLogSources: false });
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
      podmanApi: { info: Effect.succeed({}), ping: Effect.succeed(undefined) },
      logFileAccess: fs.access,
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities.serviceLogSources).toBe(true);
  });

  test("declares macOS support with slow bind mount performance", async () => {
    const layer = makeProviderLayer({
      platform: "darwin",
      podmanApi: { info: Effect.succeed({}), ping: Effect.succeed(undefined) },
    });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.platform).toBe("darwin");
    expect(runtimeProvider.capabilities).toEqual({ ...macosMvpCapabilities, serviceLogSources: false });
    expect(runtimeProvider.capabilities).toEqual({
      ...mvpProviderCapabilities("darwin"),
      serviceLogSources: false,
    });
    expect(runtimeProvider.capabilities.bindMounts).toBe(true);
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe("slow");
  });

  test("declares Windows support with slow bind mount performance", async () => {
    const layer = makeProviderLayer({ platform: "win32" });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.platform).toBe("win32");
    expect(runtimeProvider.capabilities).toEqual({
      ...mvpProviderCapabilities("win32"),
      serviceLogSources: false,
    });
    expect(runtimeProvider.capabilities.bindMounts).toBe(true);
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe("slow");
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

    expect(capabilities).toEqual(linuxMvpCapabilities);
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
