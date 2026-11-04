import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  MANAGED_SOCKET_PATH_MAX_BYTES,
  managedLaunchStatePath,
  managedPodmanChildEnv,
  managedPodmanGlobalArgs,
  managedPodmanOverlayEnv,
  managedSocketPathByteLength,
  privateRuntimeDirName,
  withoutPodmanRedirectsDefined,
} from "../src/podman/managed-invocation.ts";

describe("managedPodmanGlobalArgs", () => {
  test("emits --root, --runroot, --config in order; optional storage-opt last", () => {
    expect(
      managedPodmanGlobalArgs({
        runtimeStorageDir: "/data/runtime/storage",
        runtimeRunDir: "/data/runtime/run",
        runtimeConfigDir: "/data/runtime/config",
      }),
    ).toEqual([
      "--root",
      "/data/runtime/storage",
      "--runroot",
      "/data/runtime/run",
      "--config",
      "/data/runtime/config",
    ]);
    expect(
      managedPodmanGlobalArgs({
        runtimeStorageDir: "/s",
        runtimeRunDir: "/r",
        runtimeConfigDir: "/c",
        runtimeBinDir: "/b",
      }),
    ).toEqual([
      "--root",
      "/s",
      "--runroot",
      "/r",
      "--config",
      "/c",
      "--storage-opt",
      "overlay.mount_program=/b/fuse-overlayfs",
    ]);
  });
});

describe("managedPodmanOverlayEnv and child env", () => {
  test("overlay identity + child allowlist; hostile redirects dropped; overlay wins", () => {
    const overlay = managedPodmanOverlayEnv({
      runtimeConfigDir: "/cfg",
      runtimeBinDir: "/bin",
      privateRuntimeDir: "/run/user/1000/lando-abc",
      hostPath: "/usr/bin",
    });
    expect(overlay).toMatchObject({
      CONTAINERS_CONF: "/cfg/containers.conf",
      CONTAINERS_REGISTRIES_CONF: "/cfg/registries.conf",
      XDG_CONFIG_HOME: "/cfg",
      DISABLE_HC_SYSTEMD: "true",
      LANDO_MANAGED_CONFIG_REVISION: "2-native-init",
      XDG_RUNTIME_DIR: "/run/user/1000/lando-abc",
    });
    expect(overlay.PATH?.startsWith("/bin")).toBe(true);
    expect(overlay.PATH?.endsWith("/usr/bin")).toBe(true);

    const host = {
      HOME: "/home/me",
      USER: "me",
      LOGNAME: "me",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_TIME: "C",
      TZ: "UTC",
      TMPDIR: "/tmp",
      HTTP_PROXY: "http://proxy:8080",
      https_proxy: "http://proxy:8443",
      NO_PROXY: "localhost",
      ALL_PROXY: "socks5://proxy:1080",
      SSL_CERT_FILE: "/certs/ca.pem",
      SSL_CERT_DIR: "/certs",
      REGISTRY_AUTH_FILE: "/auth.json",
      DOCKER_CONFIG: "/docker",
      PATH: "/should-not-win",
      CONTAINER_HOST: "unix:///hostile.sock",
      CONTAINERS_CONF_OVERRIDE: "/evil.conf",
      _PODMAN_PAUSE: "1",
      STORAGE_OPTS: "evil=1",
      SECRET_TOKEN: "nope",
      XDG_RUNTIME_DIR: "/host-runtime",
    };
    const child = managedPodmanChildEnv(overlay, host);
    expect(child.HOME).toBe("/home/me");
    expect(child.HTTP_PROXY).toBe("http://proxy:8080");
    expect(child.LC_ALL).toBe("C");
    expect(child.SSL_CERT_FILE).toBe("/certs/ca.pem");
    expect(child.XDG_RUNTIME_DIR).toBe("/run/user/1000/lando-abc");
    expect(child.CONTAINER_HOST).toBeUndefined();
    expect(child.CONTAINERS_CONF_OVERRIDE).toBeUndefined();
    expect(child._PODMAN_PAUSE).toBeUndefined();
    expect(child.STORAGE_OPTS).toBeUndefined();
    expect(child.SECRET_TOKEN).toBeUndefined();

    const identity = { ...overlay };
    const child2 = managedPodmanChildEnv(overlay, {
      ...host,
      LANG: "fr_FR.UTF-8",
      HTTP_PROXY: "http://other:1",
    });
    expect(Object.fromEntries(Object.keys(identity).map((k) => [k, child2[k]]))).toEqual(identity);
  });
});

describe("withoutPodmanRedirectsDefined", () => {
  test("strips machine/connection redirect and pause control vars", () => {
    const cleaned = withoutPodmanRedirectsDefined({
      HOME: "/h",
      CONTAINER_HOST: "unix:///x",
      CONTAINER_CONNECTION: "c",
      CONTAINER_SSHKEY: "k",
      CONTAINER_PASSPHRASE: "p",
      CONTAINER_PROXY: "proxy",
      PODMAN_CONNECTIONS_CONF: "conf",
      CONTAINERS_CONF_OVERRIDE: "o",
      _PODMAN_PAUSE: "1",
      PODMAN_NO_PAUSE_PROCESS: "1",
      _CONTAINERS_USERNS_CONFIGURED: "1",
      _CONTAINERS_ROOTLESS_UID: "0",
      _CONTAINERS_ROOTLESS_GID: "0",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(cleaned.HOME).toBe("/h");
    expect(cleaned.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(cleaned.CONTAINER_HOST).toBeUndefined();
    expect(cleaned._PODMAN_PAUSE).toBeUndefined();
    expect(cleaned._CONTAINERS_ROOTLESS_UID).toBeUndefined();
    expect(withoutPodmanRedirectsDefined({ A: "1", CONTAINER_HOST: "x", B: undefined })).toEqual({ A: "1" });
  });
});

describe("managed socket path byte limit", () => {
  test("counts UTF-8 bytes at the socket path limit, including multibyte", () => {
    const ascii107 = "a".repeat(MANAGED_SOCKET_PATH_MAX_BYTES);
    expect(managedSocketPathByteLength(ascii107)).toBe(107);
    expect(managedSocketPathByteLength("a".repeat(108))).toBe(108);
    // U+00E9 is two UTF-8 bytes; 54 * 2 = 108.
    expect(managedSocketPathByteLength("é".repeat(54))).toBe(108);
    expect(managedSocketPathByteLength(`${"é".repeat(53)}a`)).toBe(107);
  });
});

describe("privateRuntimeDirName and launch state path", () => {
  test("hashes the canonical runtime dir into a stable leaf name", () => {
    const canonical = "/canonical/runtime";
    const expected = `lando-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
    expect(privateRuntimeDirName(canonical)).toBe(expected);
  });

  test("launch state path is the pid path plus .launch.json", () => {
    expect(managedLaunchStatePath("/data/runtime/run/podman.pid")).toBe(
      "/data/runtime/run/podman.pid.launch.json",
    );
  });
});
