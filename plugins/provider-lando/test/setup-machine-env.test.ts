import { describe, expect, test } from "bun:test";

import { managedMachineCliEnv } from "../src/setup.ts";

describe("managed machine/version CLI spawn env", () => {
  test("drops Podman redirect and pause-control variables", () => {
    const env = managedMachineCliEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      USER: "dev",
      LANG: "C.UTF-8",
      HTTP_PROXY: "http://proxy.example",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      CONTAINER_HOST: "unix:///nonexistent.sock",
      CONTAINER_CONNECTION: "hostile",
      CONTAINER_SSHKEY: "/tmp/key",
      CONTAINER_PASSPHRASE: "secret",
      CONTAINER_PROXY: "socks5://proxy",
      PODMAN_CONNECTIONS_CONF: "/tmp/connections.json",
      CONTAINERS_CONF_OVERRIDE: "/tmp/override.conf",
      _PODMAN_PAUSE: "1",
      PODMAN_NO_PAUSE_PROCESS: "1",
      _CONTAINERS_USERNS_CONFIGURED: "1",
      _CONTAINERS_ROOTLESS_UID: "1000",
      _CONTAINERS_ROOTLESS_GID: "1000",
      STORAGE_OPTS: "should-remain-as-unlisted-host-var-is-kept-for-machine-cli",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.USER).toBe("dev");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.HTTP_PROXY).toBe("http://proxy.example");
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");
    // Machine CLI uses a denylist, so ordinary host vars stay.
    expect(env.STORAGE_OPTS).toBe("should-remain-as-unlisted-host-var-is-kept-for-machine-cli");
    for (const key of [
      "CONTAINER_HOST",
      "CONTAINER_CONNECTION",
      "CONTAINER_SSHKEY",
      "CONTAINER_PASSPHRASE",
      "CONTAINER_PROXY",
      "PODMAN_CONNECTIONS_CONF",
      "CONTAINERS_CONF_OVERRIDE",
      "_PODMAN_PAUSE",
      "PODMAN_NO_PAUSE_PROCESS",
      "_CONTAINERS_USERNS_CONFIGURED",
      "_CONTAINERS_ROOTLESS_UID",
      "_CONTAINERS_ROOTLESS_GID",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });
});
