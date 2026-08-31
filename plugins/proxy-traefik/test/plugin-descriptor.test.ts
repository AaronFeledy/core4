import { describe, expect, test } from "bun:test";

import {
  PLUGIN_NAME,
  globalServices,
  leftoverProxyPortsCheck,
  manifest,
  plugin,
  preferredHostPortsCheck,
  proxy,
  proxyServices,
  proxyTlsDoctorCheck,
} from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/proxy-traefik plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.contributes id has a matching descriptor entry", () => {
    // Given
    const contributes = manifest.contributes ?? {};

    // When / Then — proxyServices
    for (const id of contributionIds(contributes.proxyServices)) {
      expect(plugin.proxyServices?.has(id)).toBe(true);
    }

    // When / Then — globalServices
    for (const id of contributionIds(contributes.globalServices)) {
      expect(plugin.globalServices?.has(id)).toBe(true);
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.layer).toBe(proxy);
    expect(plugin.proxyServices).toBe(proxyServices);
    expect(plugin.globalServices).toBe(globalServices);
  });

  test("wires the proxy TLS, leftover loopback-port, and preferred-host-port doctor contributions", () => {
    // Given / When the plugin descriptor is exported
    const doctorChecks = plugin.doctorChecks ?? [];

    // Then
    expect(doctorChecks.map((check) => check.id)).toEqual([
      "proxy-tls",
      "proxy-loopback-ports",
      "preferred-host-ports",
    ]);
    expect(doctorChecks.at(0)).toBe(proxyTlsDoctorCheck);
    expect(doctorChecks.at(1)).toBe(leftoverProxyPortsCheck);
    expect(doctorChecks.at(2)).toBe(preferredHostPortsCheck);
    expect(proxyTlsDoctorCheck.relevant).toBeUndefined();
    expect(leftoverProxyPortsCheck.relevant).toBeUndefined();
    expect(preferredHostPortsCheck.relevant).toBeUndefined();
  });
});
