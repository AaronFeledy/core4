import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { ProviderCapabilities } from "@lando/sdk/schema";

describe("container runtime capability helpers", () => {
  test("builds common provider capability shapes from explicit constants", () => {
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "portable",
      providerExtensions: [],
    });

    expect(capabilities.rootless).toBe(false);
    expect(capabilities.tlsCertificates).toBe("none");
    expect(capabilities.bindMountPerformance).toBe("native");
    expect(capabilities.copyOnWriteAppRoot).toBe(false);
  });

  test("defaults composeKnobs to an empty supported set when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "portable",
      providerExtensions: [],
    });

    expect(capabilities.composeKnobs).toEqual({ supported: [] });
  });

  test("passes an explicit composeKnobs declaration through unchanged", () => {
    const composeKnobs = { supported: ["restart", "tmpfs"] as const };
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "native",
      composeKnobs: { supported: ["restart", "tmpfs"] },
      providerExtensions: [],
    });

    expect(capabilities.composeKnobs).toEqual(composeKnobs);
    expect(Schema.decodeSync(ProviderCapabilities)(capabilities)).toEqual(capabilities);
  });

  test("leaves composeServiceFields absent when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "portable",
      providerExtensions: [],
    });

    expect(Object.hasOwn(capabilities, "composeServiceFields")).toBe(false);
  });

  test("passes an explicit composeServiceFields declaration through unchanged", () => {
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "portable",
      composeServiceFields: { supported: ["labels"] },
      providerExtensions: [],
    });

    expect(capabilities.composeServiceFields).toEqual({ supported: ["labels"] });
  });

  test("leaves composePreservedPaths absent when the constant is omitted", () => {
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "native",
      providerExtensions: [],
    });

    expect(Object.hasOwn(capabilities, "composePreservedPaths")).toBe(false);
  });

  test("passes an explicit composePreservedPaths declaration through unchanged", () => {
    const capabilities = buildProviderCapabilities({
      bindMounts: true,
      bindMountPerformance: "native",
      tlsCertificates: "none",
      rootless: false,
      composeSpec: "native",
      composePreservedPaths: { supported: ["healthcheck.start_interval"] },
      providerExtensions: [],
    });

    expect(capabilities.composePreservedPaths).toEqual({
      supported: ["healthcheck.start_interval"],
    });
  });
});
