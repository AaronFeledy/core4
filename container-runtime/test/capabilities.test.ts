import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type ProviderCapabilityConstants,
  buildProviderCapabilities,
} from "@lando/container-runtime/capabilities";
import { ProviderCapabilities } from "@lando/sdk/schema";

const baseConstants: Omit<ProviderCapabilityConstants, "composeSpec"> = {
  bindMounts: true,
  bindMountPerformance: "native",
  tlsCertificates: "none",
  rootless: false,
  providerExtensions: [],
};

describe("container runtime capability helpers", () => {
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
});
