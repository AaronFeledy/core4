import { describe, expect, test } from "bun:test";

import {
  PLUGIN_NAME,
  advertisedProxyPortsCheck,
  globalServices,
  leftoverProxyPortsCheck,
  legacyRouteFilesCheck,
  manifest,
  plugin,
  preferredHostPortsCheck,
  proxyTlsDoctorCheck,
  routerBindAddressCheck,
  routerFileWatcherCheck,
  routerServices,
  socketProxyHelperDoctorCheck,
} from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/proxy-traefik plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.contributes id has a matching descriptor entry", () => {
    // Given
    const contributes = manifest.contributes ?? {};

    // When / Then
    for (const id of contributionIds(contributes.routerServices)) {
      expect(plugin.routerServices?.has(id)).toBe(true);
    }

    // When / Then
    for (const id of contributionIds(contributes.globalServices)) {
      expect(plugin.globalServices?.has(id)).toBe(true);
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.layer).toBeUndefined();
    expect(plugin.routerServices).toBe(routerServices);
    expect(plugin.globalServices).toBe(globalServices);
  });

  test("registers socket-proxy host maintainer on linux", () => {
    if (process.platform === "linux") {
      expect(plugin.hostMaintainers?.map((m) => m.id)).toEqual(["socket-proxy-helper"]);
      expect(plugin.hostMaintainers?.[0]?.uninstall).toBeDefined();
    } else {
      expect(plugin.hostMaintainers ?? []).toEqual([]);
    }
  });

  test("wires the proxy TLS, leftover loopback-port, preferred-host-port, advertised-port, router-file-watcher, legacy-route-files, bind-address, and socket-proxy-helper doctor contributions", () => {
    // Given / When
    const doctorChecks = plugin.doctorChecks ?? [];

    // Then
    expect(doctorChecks.map((check) => check.id)).toEqual([
      "proxy-tls",
      "proxy-loopback-ports",
      "preferred-host-ports",
      "proxy-advertised-ports",
      "router-file-watcher",
      "legacy-route-files",
      "router-bind-address",
      "socket-proxy-helper",
    ]);
    expect(doctorChecks.at(0)).toBe(proxyTlsDoctorCheck);
    expect(doctorChecks.at(1)).toBe(leftoverProxyPortsCheck);
    expect(doctorChecks.at(2)).toBe(preferredHostPortsCheck);
    expect(doctorChecks.at(3)).toBe(advertisedProxyPortsCheck);
    expect(doctorChecks.at(4)).toBe(routerFileWatcherCheck);
    expect(doctorChecks.at(5)).toBe(legacyRouteFilesCheck);
    expect(doctorChecks.at(6)).toBe(routerBindAddressCheck);
    expect(doctorChecks.at(7)).toBe(socketProxyHelperDoctorCheck);
    expect(proxyTlsDoctorCheck.relevant).toBeUndefined();
    expect(leftoverProxyPortsCheck.relevant).toBeUndefined();
    expect(preferredHostPortsCheck.relevant).toBeUndefined();
    expect(routerFileWatcherCheck.relevant).toBeUndefined();
    expect(legacyRouteFilesCheck.relevant).toBeUndefined();
    expect(routerBindAddressCheck.relevant).toBeUndefined();
  });
});
