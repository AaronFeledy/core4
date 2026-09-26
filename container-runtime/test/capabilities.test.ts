import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type ProviderCapabilityConstants,
  agentSocketCapabilities,
  buildProviderCapabilities,
  engineInfoArchitecture,
  hostProxyCapabilities,
  hostProxyContainerTargets,
} from "@lando/container-runtime/capabilities";
import { type AgentSocketDelivery, ProviderCapabilities } from "@lando/sdk/schema";

const baseConstants: Omit<ProviderCapabilityConstants, "composeSpec"> = {
  bindMounts: true,
  bindMountPerformance: "native",
  tlsCertificates: "none",
  rootless: false,
  providerExtensions: [],
};

describe("container runtime capability helpers", () => {
  test("buildProviderCapabilities carries agentSocket when declared", () => {
    // Given: a provider declaring guest bridge delivery.
    const constants = {
      ...baseConstants,
      composeSpec: "portable",
      agentSocket: { delivery: "guest-bridge" },
    } satisfies ProviderCapabilityConstants;
    // When: the provider capability schema is constructed.
    const capabilities = buildProviderCapabilities(constants);
    // Then: the declaration survives schema decoding.
    expect(capabilities.agentSocket).toEqual({ delivery: "guest-bridge" });
  });

  test("agentSocketCapabilities omits unavailable delivery", () => {
    // Given / When: no delivery is available.
    const capabilities = agentSocketCapabilities(undefined);
    // Then: no capability is advertised.
    expect(capabilities).toBeUndefined();
  });

  test.each(["bind-directory", "guest-bridge", "volume-relay"] satisfies AgentSocketDelivery[])(
    "agentSocketCapabilities declares %s",
    (delivery) => {
      // Given / When: a supported delivery is declared.
      const capabilities = agentSocketCapabilities(delivery);
      // Then: its delivery is preserved.
      expect(capabilities).toEqual({ delivery });
    },
  );

  test("builds common provider capability shapes from explicit constants", () => {
    const capabilities = buildProviderCapabilities({ ...baseConstants, composeSpec: "portable" });

    expect(capabilities.rootless).toBe(false);
    expect(capabilities.tlsCertificates).toBe("none");
    expect(capabilities.bindMountPerformance).toBe("native");
    expect(capabilities.copyOnWriteAppRoot).toBe(false);
  });

  test("defaults architectureEmulation to false when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({ ...baseConstants, composeSpec: "portable" });

    expect(capabilities.architectureEmulation).toBe(false);
  });

  test("passes an explicit architectureEmulation declaration through unchanged", () => {
    const capabilities = buildProviderCapabilities({
      ...baseConstants,
      composeSpec: "portable",
      architectureEmulation: true,
    });

    expect(capabilities.architectureEmulation).toBe(true);
  });

  test("defaults composeKnobs to an empty supported set when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({ ...baseConstants, composeSpec: "portable" });

    expect(capabilities.composeKnobs).toEqual({ supported: [] });
  });

  test("passes an explicit composeKnobs declaration through unchanged", () => {
    const composeKnobs = { supported: ["restart", "tmpfs"] } as const;
    const capabilities = buildProviderCapabilities({
      ...baseConstants,
      composeSpec: "native",
      composeKnobs,
    });

    expect(capabilities.composeKnobs).toEqual(composeKnobs);
    expect(Schema.decodeSync(ProviderCapabilities)(capabilities)).toEqual(capabilities);
  });

  test("leaves composeServiceFields absent when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({ ...baseConstants, composeSpec: "portable" });

    expect(Object.hasOwn(capabilities, "composeServiceFields")).toBe(false);
  });

  test("passes an explicit composeServiceFields declaration through unchanged", () => {
    const capabilities = buildProviderCapabilities({
      ...baseConstants,
      composeSpec: "portable",
      composeServiceFields: { supported: ["labels"] },
    });

    expect(capabilities.composeServiceFields).toEqual({ supported: ["labels"] });
  });

  test("leaves composeProjectFields absent when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({ ...baseConstants, composeSpec: "native" });

    expect(Object.hasOwn(capabilities, "composeProjectFields")).toBe(false);
  });

  test("passes an explicit composeProjectFields declaration through unchanged", () => {
    const capabilities = buildProviderCapabilities({
      ...baseConstants,
      composeSpec: "native",
      composeProjectFields: { supported: ["configs"] },
    });

    expect(capabilities.composeProjectFields).toEqual({ supported: ["configs"] });
  });

  test("leaves composePreservedPaths absent when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({ ...baseConstants, composeSpec: "native" });

    expect(Object.hasOwn(capabilities, "composePreservedPaths")).toBe(false);
  });

  test("passes an explicit composePreservedPaths declaration through unchanged", () => {
    const capabilities = buildProviderCapabilities({
      ...baseConstants,
      composeSpec: "native",
      composePreservedPaths: { supported: ["healthcheck.start_interval"] },
    });

    expect(capabilities.composePreservedPaths).toEqual({
      supported: ["healthcheck.start_interval"],
    });
  });

  test("maps engine architecture aliases to Linux container targets", () => {
    expect(hostProxyContainerTargets("amd64")).toEqual([{ os: "linux", arch: "x64" }]);
    expect(hostProxyContainerTargets("aarch64")).toEqual([{ os: "linux", arch: "arm64" }]);
    expect(hostProxyContainerTargets("riscv64")).toEqual([]);
  });

  test("adds the provider gateway only on Windows hosts", () => {
    const targets = hostProxyContainerTargets("x86_64");
    expect(hostProxyCapabilities("linux", [], "host.containers.internal")).toBeUndefined();
    expect(hostProxyCapabilities("darwin", targets, "host.containers.internal")).toEqual({
      containerTargets: targets,
    });
    expect(hostProxyCapabilities("win32", [], "host.containers.internal")).toEqual({
      containerTargets: [],
      tcpHostGateway: "host.containers.internal",
    });
  });

  test("prefers nested engine host architecture over the top-level fallback", () => {
    expect(engineInfoArchitecture({ host: { arch: "arm64" }, Architecture: "amd64" })).toBe("arm64");
    expect(engineInfoArchitecture({ Architecture: "amd64" })).toBe("amd64");
    expect(engineInfoArchitecture({ host: {} })).toBeUndefined();
  });
});
