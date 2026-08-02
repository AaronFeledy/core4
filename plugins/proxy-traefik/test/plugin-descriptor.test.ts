import { describe, expect, test } from "bun:test";

import type { PluginDoctorCheckContribution } from "@lando/sdk/plugins";

import * as proxyTraefikExports from "../src/index.ts";
import { PLUGIN_NAME, globalServices, manifest, plugin, proxy, proxyServices } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

const hasProxyTlsDoctorCheck = (
  moduleExports: typeof proxyTraefikExports,
): moduleExports is typeof proxyTraefikExports & {
  readonly proxyTlsDoctorCheck: PluginDoctorCheckContribution;
} => "proxyTlsDoctorCheck" in moduleExports;

const proxyTlsDoctorCheck = hasProxyTlsDoctorCheck(proxyTraefikExports)
  ? proxyTraefikExports.proxyTlsDoctorCheck
  : undefined;

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

  test("wires the proxy TLS doctor contribution", () => {
    // Given / When the plugin descriptor is exported
    const doctorChecks = plugin.doctorChecks ?? [];

    // Then
    expect(doctorChecks.map((check) => check.id)).toEqual(["proxy-tls"]);
    expect(doctorChecks.at(0)).toBe(proxyTlsDoctorCheck);
    expect(proxyTlsDoctorCheck?.relevant).toBeUndefined();
  });
});
