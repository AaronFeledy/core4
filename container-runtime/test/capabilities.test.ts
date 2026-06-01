import { describe, expect, test } from "bun:test";

import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";

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
});
