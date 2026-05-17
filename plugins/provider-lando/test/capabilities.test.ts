import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  decodeProviderCapabilities,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  makePodmanInfoRequest,
  makeProviderLayer,
  providerLandoCapabilitiesForPlatform,
} from "@lando/provider-lando";
import { ProviderCapabilities } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

describe("provider-lando capabilities", () => {
  test("declares every ProviderCapabilities field for Linux and macOS", () => {
    const expectedFields = Object.keys(ProviderCapabilities.fields).sort();
    const linux = providerLandoCapabilitiesForPlatform("linux");
    const macos = providerLandoCapabilitiesForPlatform("darwin");
    const windows = providerLandoCapabilitiesForPlatform("win32");
    const unsupported = providerLandoCapabilitiesForPlatform("freebsd");

    expect(Object.keys(linux).sort()).toEqual(expectedFields);
    expect(Object.keys(macos).sort()).toEqual(expectedFields);
    expect(Object.keys(windows).sort()).toEqual(expectedFields);
    expect(Object.keys(unsupported).sort()).toEqual(expectedFields);
    expect(linux.bindMountPerformance).toBe("native");
    expect(macos.bindMountPerformance).toBe("slow");
    expect(windows.bindMountPerformance).toBe("slow");
    expect(unsupported.bindMounts).toBe(false);
    expect(unsupported.bindMountPerformance).toBe("none");
  });

  test("declares the Linux MVP ProviderCapabilities through the Live Layer", async () => {
    const layer = makeProviderLayer({ podmanApi: { info: Effect.succeed({}) } });
    const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));

    expect(runtimeProvider.capabilities).toEqual(linuxMvpCapabilities);
    expect(runtimeProvider.capabilities.bindMountPerformance).toBe(
      providerLandoCapabilitiesForPlatform(process.platform).bindMountPerformance,
    );
    expect(runtimeProvider.capabilities.sharedCrossAppNetwork).toBe(false);
    expect(runtimeProvider.capabilities.copyMounts).toBe(false);
    expect(Object.keys(runtimeProvider.capabilities).sort()).toEqual(
      Object.keys(ProviderCapabilities.fields).sort(),
    );
  });

  test("builds Podman API HTTP-over-UNIX requests without invoking the podman binary", () => {
    const request = makePodmanInfoRequest("/tmp/podman.sock");

    expect(request.command).toBe("curl");
    expect(request.command).not.toBe("podman");
    expect(request.socketUrl).toBe("unix:///tmp/podman.sock");
    expect(request.args).toContain("--unix-socket");
    expect(request.args).toContain("/tmp/podman.sock");
    expect(request.args).toContain("http://localhost/v5.0.0/libpod/info");
  });

  test("decodes capabilities through the SDK schema", async () => {
    const capabilities = await Effect.runPromise(
      introspectProviderCapabilities({ info: Effect.succeed({}) }),
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
