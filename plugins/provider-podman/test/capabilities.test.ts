import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";

import {
  InvalidPodmanMachineNameError,
  UnsupportedPodmanSocketError,
  discoverPodmanDesktopSockets,
  linuxPodmanCapabilities,
  macosPodmanCapabilities,
  makeRuntimeProvider,
  podmanCapabilitiesForPlatform,
  resolvePodmanDesktopMachine,
  resolvePodmanSocket,
  windowsPodmanCapabilities,
} from "@lando/provider-podman";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import { ProviderCapabilities } from "@lando/sdk/schema";

describe("provider-podman capabilities", () => {
  test("declares every ProviderCapabilities field for Linux, macOS, and Windows", () => {
    const expectedFields = Object.keys(ProviderCapabilities.fields)
      .filter((field) => field !== "hostProxy")
      .sort();
    const expectedWindowsFields = Object.keys(ProviderCapabilities.fields).sort();
    const linux = podmanCapabilitiesForPlatform("linux");
    const macos = podmanCapabilitiesForPlatform("darwin");
    const windows = podmanCapabilitiesForPlatform("win32");

    expect(Object.keys(linux).sort()).toEqual(expectedFields);
    expect(Object.keys(macos).sort()).toEqual(expectedFields);
    expect(Object.keys(windows).sort()).toEqual(expectedWindowsFields);
    expect(linux.sharedCrossAppNetwork).toBe(true);
    expect(macos.sharedCrossAppNetwork).toBe(true);
    expect(windows.sharedCrossAppNetwork).toBe(true);
  });

  test("declares native bind-mount performance on Linux", () => {
    expect(linuxPodmanCapabilities.bindMountPerformance).toBe("native");
    expect(linuxPodmanCapabilities.bindMounts).toBe(true);
    expect(linuxPodmanCapabilities.artifactBuild).toBe(true);
    expect(linuxPodmanCapabilities.rootless).toBe(true);
  });

  test("declares slow bind-mount performance on macOS and Windows (VM-mediated)", () => {
    expect(macosPodmanCapabilities.bindMountPerformance).toBe("slow");
    expect(windowsPodmanCapabilities.bindMountPerformance).toBe("slow");
    expect(macosPodmanCapabilities.bindMounts).toBe(true);
    expect(windowsPodmanCapabilities.bindMounts).toBe(true);
  });

  test("advertises sharedCrossAppNetwork on every supported platform", () => {
    expect(linuxPodmanCapabilities.sharedCrossAppNetwork).toBe(true);
    expect(macosPodmanCapabilities.sharedCrossAppNetwork).toBe(true);
    expect(windowsPodmanCapabilities.sharedCrossAppNetwork).toBe(true);
  });

  test("matches platform-keyed exports", () => {
    expect(podmanCapabilitiesForPlatform("linux")).toEqual(linuxPodmanCapabilities);
    expect(podmanCapabilitiesForPlatform("darwin")).toEqual(macosPodmanCapabilities);
    expect(podmanCapabilitiesForPlatform("win32")).toEqual(windowsPodmanCapabilities);
  });

  test("does not advertise host-proxy container targets without runtime API introspection", () => {
    expect(podmanCapabilitiesForPlatform("linux").hostProxy).toBeUndefined();
    expect(podmanCapabilitiesForPlatform("darwin").hostProxy).toBeUndefined();
    expect(podmanCapabilitiesForPlatform("win32").hostProxy?.containerTargets).toEqual([]);
  });

  test("advertises Podman Desktop host alias for Windows TCP transport", () => {
    expect(podmanCapabilitiesForPlatform("win32").hostProxy).toEqual({
      containerTargets: [],
      tcpHostGateway: "host.containers.internal",
    });
  });
});

describe("provider-podman socket discovery", () => {
  test("honors explicit socketPath option", () => {
    expect(resolvePodmanSocket({ socketPath: "/custom/socket", platform: "linux", env: {} })).toBe(
      "/custom/socket",
    );
  });

  test("uses LANDO_TEST_PODMAN_SOCKET when set", () => {
    expect(
      resolvePodmanSocket({
        platform: "linux",
        env: { LANDO_TEST_PODMAN_SOCKET: "/run/test/podman.sock" },
      }),
    ).toBe("/run/test/podman.sock");
  });

  test("strips unix:// prefix from DOCKER_HOST", () => {
    expect(
      resolvePodmanSocket({
        platform: "linux",
        env: { DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock" },
      }),
    ).toBe("/run/user/1000/podman/podman.sock");
  });

  test("DOCKER_HOST without prefix passes through unchanged", () => {
    expect(
      resolvePodmanSocket({
        platform: "linux",
        env: { DOCKER_HOST: "tcp://127.0.0.1:2375" },
      }),
    ).toBe("tcp://127.0.0.1:2375");
  });

  test("redacts URL userinfo in unsupported socket error details", () => {
    const error = new UnsupportedPodmanSocketError("tcp://user:pass@127.0.0.1:2375");

    expect(error.details).toEqual({ socketPath: "tcp://[redacted]@127.0.0.1:2375" });
    expect(JSON.stringify(error.details)).not.toContain("user:pass");
  });

  test("falls back to $XDG_RUNTIME_DIR/podman/podman.sock on Linux", () => {
    expect(resolvePodmanSocket({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" } })).toBe(
      "/run/user/1000/podman/podman.sock",
    );
  });

  test("falls back to the rootless /run/user socket without XDG_RUNTIME_DIR on Linux", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(resolvePodmanSocket({ platform: "linux", env: {} })).toBe(`/run/user/${uid}/podman/podman.sock`);
  });

  test("honors discovery precedence: explicit > LANDO_TEST_PODMAN_SOCKET > DOCKER_HOST > default", () => {
    expect(
      resolvePodmanSocket({
        socketPath: "/explicit/sock",
        platform: "linux",
        env: {
          LANDO_TEST_PODMAN_SOCKET: "/test/sock",
          DOCKER_HOST: "unix:///docker/host",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      }),
    ).toBe("/explicit/sock");

    expect(
      resolvePodmanSocket({
        platform: "linux",
        env: {
          LANDO_TEST_PODMAN_SOCKET: "/test/sock",
          DOCKER_HOST: "unix:///docker/host",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      }),
    ).toBe("/test/sock");

    expect(
      resolvePodmanSocket({
        platform: "linux",
        env: { DOCKER_HOST: "unix:///docker/host", XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    ).toBe("/docker/host");
  });

  test("uses Podman Desktop default path on macOS via $HOME", () => {
    expect(resolvePodmanSocket({ platform: "darwin", env: { HOME: "/Users/alice" } })).toBe(
      "/Users/alice/.local/share/containers/podman/machine/podman-machine-default/podman.sock",
    );
  });

  test("uses npipe path on Windows by default", () => {
    expect(resolvePodmanSocket({ platform: "win32", env: {} })).toBe("npipe://./pipe/podman-machine-default");
  });

  test("honors LANDO_PODMAN_MACHINE override on macOS Podman Desktop", () => {
    expect(
      resolvePodmanSocket({
        platform: "darwin",
        env: { HOME: "/Users/alice", LANDO_PODMAN_MACHINE: "podman-machine-custom" },
      }),
    ).toBe("/Users/alice/.local/share/containers/podman/machine/podman-machine-custom/podman.sock");
  });

  test("honors CONTAINERS_MACHINE_PROVIDER-style PODMAN_MACHINE_NAME override on Windows Podman Desktop", () => {
    expect(
      resolvePodmanSocket({
        platform: "win32",
        env: { PODMAN_MACHINE_NAME: "podman-machine-rootful" },
      }),
    ).toBe("npipe://./pipe/podman-machine-rootful");
  });

  test("LANDO_PODMAN_MACHINE takes precedence over PODMAN_MACHINE_NAME", () => {
    expect(
      resolvePodmanSocket({
        platform: "darwin",
        env: {
          HOME: "/Users/alice",
          LANDO_PODMAN_MACHINE: "lando-machine",
          PODMAN_MACHINE_NAME: "podman-machine-other",
        },
      }),
    ).toBe("/Users/alice/.local/share/containers/podman/machine/lando-machine/podman.sock");
  });
});

describe("provider-podman Podman Desktop discovery", () => {
  test("discoverPodmanDesktopSockets enumerates known macOS default machine candidates", () => {
    const candidates = discoverPodmanDesktopSockets({
      platform: "darwin",
      env: { HOME: "/Users/alice" },
    });

    expect(candidates).toContain(
      "/Users/alice/.local/share/containers/podman/machine/podman-machine-default/podman.sock",
    );
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  test("discoverPodmanDesktopSockets enumerates Windows npipe candidates", () => {
    const candidates = discoverPodmanDesktopSockets({ platform: "win32", env: {} });
    expect(candidates).toContain("npipe://./pipe/podman-machine-default");
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  test("discoverPodmanDesktopSockets places the env-overridden machine name first when supplied", () => {
    const candidates = discoverPodmanDesktopSockets({
      platform: "darwin",
      env: { HOME: "/Users/alice", LANDO_PODMAN_MACHINE: "my-machine" },
    });
    expect(candidates[0]).toBe("/Users/alice/.local/share/containers/podman/machine/my-machine/podman.sock");
  });

  test("discoverPodmanDesktopSockets returns an empty list on Linux (rootless socket lives elsewhere)", () => {
    const candidates = discoverPodmanDesktopSockets({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    });
    expect(candidates).toEqual([]);
  });

  test("resolvePodmanDesktopMachine defaults to podman-machine-default and honors overrides", () => {
    expect(resolvePodmanDesktopMachine({})).toBe("podman-machine-default");
    expect(resolvePodmanDesktopMachine({ PODMAN_MACHINE_NAME: "rootful" })).toBe("rootful");
    expect(
      resolvePodmanDesktopMachine({ LANDO_PODMAN_MACHINE: "lando", PODMAN_MACHINE_NAME: "ignored" }),
    ).toBe("lando");
  });

  test("rejects malformed Podman Desktop machine names with a tagged provider error", () => {
    expect(() => resolvePodmanDesktopMachine({ LANDO_PODMAN_MACHINE: "bad;name" })).toThrow(
      InvalidPodmanMachineNameError,
    );
    expect(() => resolvePodmanDesktopMachine({ PODMAN_MACHINE_NAME: "../podman" })).toThrow(
      InvalidPodmanMachineNameError,
    );
  });
});

describe("provider-podman RuntimeProvider layer", () => {
  test("introspects platform-specific capabilities", async () => {
    const linuxProvider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "x64" } }) },
      }),
    );
    const macosProvider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "darwin",
        arch: "arm64",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "arm64" } }) },
      }),
    );
    const windowsProvider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "win32",
        arch: "arm64",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "arm64" } }) },
      }),
    );

    expect(linuxProvider.id).toBe("podman");
    expect(linuxProvider.capabilities.hostProxy?.containerTargets).toEqual([{ os: "linux", arch: "x64" }]);
    expect(macosProvider.capabilities.hostProxy?.containerTargets).toEqual([{ os: "linux", arch: "arm64" }]);
    expect(windowsProvider.capabilities.hostProxy?.containerTargets).toEqual([
      { os: "linux", arch: "arm64" },
    ]);
    expect(windowsProvider.capabilities).toEqual({
      ...podmanCapabilitiesForPlatform("win32", [{ os: "linux", arch: "arm64" }]),
      serviceLogSources: false,
    });
  });

  test("uses Podman API runtime architecture over injected host architecture", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "win32",
        arch: "x64",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "aarch64" } }) },
      }),
    );

    expect(provider.capabilities.hostProxy?.containerTargets).toEqual([{ os: "linux", arch: "arm64" }]);
  });

  test("omits Podman host-proxy target capability when API architecture is missing", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "win32",
        arch: "arm64",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: {} }) },
      }),
    );

    expect(provider.capabilities.hostProxy?.containerTargets).toEqual([]);
  });

  test("advertises service log source following only when file access is injected", async () => {
    const fs = makeMemoryLogFileAccess();
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "x64" } }) },
        logFileAccess: fs.access,
      }),
    );

    expect(provider.capabilities.serviceLogSources).toBe(true);
  });

  test("advertises service log source following when a helper payload matches Podman info architecture", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "x64" } }) },
        logFileHelperPayloads: { "linux-x64": new Uint8Array([1, 2, 3]) },
      }),
    );

    expect(provider.capabilities.serviceLogSources).toBe(true);
  });

  test("does not advertise service log source following when Podman info architecture has no helper payload", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "aarch64" } }) },
        logFileHelperPayloads: { "linux-x64": new Uint8Array([1, 2, 3]) },
      }),
    );

    expect(provider.capabilities.serviceLogSources).toBe(false);
  });

  test("constructs the Podman API client through the resolved socket path", async () => {
    const createdHosts: Array<string> = [];
    await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        podmanApiFactory: (socketPath) => {
          createdHosts.push(socketPath);
          return { info: Effect.succeed({ version: { Version: "6.0.2" } }) };
        },
      }),
    );
    expect(createdHosts).toEqual(["/run/user/1000/podman/podman.sock"]);
  });

  test("constructs the default Windows Podman Desktop API client through the npipe socket", async () => {
    const createdHosts: Array<string> = [];
    await Effect.runPromise(
      makeRuntimeProvider({
        platform: "win32",
        env: {},
        podmanApiFactory: (socketPath) => {
          createdHosts.push(socketPath);
          return { info: Effect.succeed({ version: { Version: "6.0.2" } }) };
        },
      }),
    );
    expect(createdHosts).toEqual(["npipe://./pipe/podman-machine-default"]);
  });

  test("does not validate Podman Desktop machine names on Linux", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {
          XDG_RUNTIME_DIR: "/run/user/1000",
          LANDO_PODMAN_MACHINE: "bad;name",
        },
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "x64" } }) },
      }),
    );

    expect(provider.id).toBe("podman");
  });

  test("rejects non-Unix DOCKER_HOST transports before constructing the API client", async () => {
    const exit = await Effect.runPromiseExit(
      makeRuntimeProvider({
        platform: "linux",
        env: { DOCKER_HOST: "tcp://127.0.0.1:2375" },
        podmanApiFactory: () => {
          throw new Error("factory should not run for unsupported transports");
        },
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(UnsupportedPodmanSocketError);
      }
    }
  });
});
