import { expect, test } from "bun:test";

import { readRuntimeBundleSources } from "./runtime-bundle-sources.ts";

test("pins both Windows machine API forwarding helpers beside Podman", async () => {
  const sources = await readRuntimeBundleSources();
  const components = sources.bundles["win32-x64"]?.components ?? [];

  expect(
    components.map((component) => ("installName" in component ? component.installName : undefined)),
  ).toEqual(expect.arrayContaining(["bin/gvproxy.exe", "bin/win-sshproxy.exe"]));
  const sshProxy = components.find((component) => component.name === "win-sshproxy");
  expect(sshProxy !== undefined && "url" in sshProxy ? sshProxy.url : undefined).toBe(
    "https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/win-sshproxy.exe",
  );
  expect(sshProxy !== undefined && "sha256" in sshProxy ? sshProxy.sha256 : undefined).toBe(
    "42cb9051ebdcaa2b607bda724c884e31f613253fe4b095c5528be1dfd48e4311",
  );
});

test("pins Windows x64 Podman remote with WSL port forwarding support", async () => {
  const sources = await readRuntimeBundleSources();
  expect(sources.runtimeVersion).toBe("0.1.6");
  const podman = sources.bundles["win32-x64"]?.components.find((component) => component.name === "podman");
  expect(podman !== undefined && "version" in podman ? podman.version : undefined).toBe("6.1.2");
  expect(podman !== undefined && "url" in podman ? podman.url : undefined).toBe(
    "https://github.com/podman-container-tools/podman/releases/download/v6.1.2/podman-remote-release-windows_amd64.zip",
  );
  expect(podman !== undefined && "sha256" in podman ? podman.sha256 : undefined).toBe(
    "98c309e1cba4f36fc89a0819607de0696d52f0dcc0c5ef3a8d5cd87fdcf062ba",
  );
  expect(podman !== undefined && "member" in podman ? podman.member : undefined).toBe(
    "podman-6.1.2/usr/bin/podman.exe",
  );
});
test("pins Windows arm64 Podman remote plus machine helpers", async () => {
  const sources = await readRuntimeBundleSources();
  const components = sources.bundles["win32-arm64"]?.components ?? [];

  expect(
    components.map((component) => ("installName" in component ? component.installName : undefined)),
  ).toEqual(["bin/podman.exe", "bin/gvproxy.exe", "bin/win-sshproxy.exe"]);

  const podman = components.find((component) => component.name === "podman");
  expect(podman !== undefined && "url" in podman ? podman.url : undefined).toBe(
    "https://github.com/podman-container-tools/podman/releases/download/v6.1.2/podman-remote-release-windows_arm64.zip",
  );
  expect(podman !== undefined && "sha256" in podman ? podman.sha256 : undefined).toBe(
    "9c652543765737d22692023e682b1dea0be72bc4dc93d1d3c940718c689360dd",
  );
  expect(podman !== undefined && "member" in podman ? podman.member : undefined).toBe(
    "podman-6.1.2/usr/bin/podman.exe",
  );

  const gvproxy = components.find((component) => component.name === "gvproxy");
  expect(gvproxy !== undefined && "url" in gvproxy ? gvproxy.url : undefined).toBe(
    "https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/gvproxy-windows-arm64.exe",
  );
  expect(gvproxy !== undefined && "sha256" in gvproxy ? gvproxy.sha256 : undefined).toBe(
    "a00867aaf0a6694877d3261d0c8e6df5dcfe8eec2fb4b81a084d2bf7a65d7ae8",
  );

  const sshProxy = components.find((component) => component.name === "win-sshproxy");
  expect(sshProxy !== undefined && "url" in sshProxy ? sshProxy.url : undefined).toBe(
    "https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/win-sshproxy-arm64.exe",
  );
  expect(sshProxy !== undefined && "sha256" in sshProxy ? sshProxy.sha256 : undefined).toBe(
    "a7e9c46ee9898a800dc8f6a0db5e5d74116a42236d96d0bb9b379b6a63512dce",
  );
});
