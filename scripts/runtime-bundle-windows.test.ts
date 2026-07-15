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
