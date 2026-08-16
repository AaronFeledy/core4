import { describe, expect, test } from "bun:test";

import { ProviderId } from "@lando/sdk/schema";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  type ProviderSelectionInputs,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../src/providers/precedence.ts";

const pid = (value: string): ProviderId => ProviderId.make(value);

const inputs = (overrides: Partial<ProviderSelectionInputs> = {}): ProviderSelectionInputs => ({
  capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
  ...overrides,
});

describe("resolveProviderSelection", () => {
  test("falls back to the capability default when no other inputs are present", () => {
    const resolution = resolveProviderSelection(inputs());
    expect(String(resolution.providerId)).toBe("lando");
    expect(resolution.source).toBe("default");
    expect(resolution.inputs.capabilityDefault).toBe(CAPABILITY_DEFAULT_PROVIDER_ID);
    expect(resolution.inputs.flag).toBeUndefined();
    expect(resolution.inputs.landofile).toBeUndefined();
    expect(resolution.inputs.env).toBeUndefined();
    expect(resolution.inputs.config).toBeUndefined();
  });

  test("config wins over capability default", () => {
    const resolution = resolveProviderSelection(inputs({ config: pid("docker") }));
    expect(String(resolution.providerId)).toBe("docker");
    expect(resolution.source).toBe("config");
  });

  test("env (LANDO_PROVIDER) wins over config", () => {
    const resolution = resolveProviderSelection(inputs({ env: pid("podman"), config: pid("docker") }));
    expect(String(resolution.providerId)).toBe("podman");
    expect(resolution.source).toBe("env");
    expect(String(resolution.inputs.config)).toBe("docker");
  });

  test("env wins over capability default", () => {
    const resolution = resolveProviderSelection(inputs({ env: pid("docker") }));
    expect(String(resolution.providerId)).toBe("docker");
    expect(resolution.source).toBe("env");
  });

  test("landofile wins over env", () => {
    const resolution = resolveProviderSelection(inputs({ landofile: pid("docker"), env: pid("podman") }));
    expect(String(resolution.providerId)).toBe("docker");
    expect(resolution.source).toBe("landofile");
  });

  test("landofile wins over config", () => {
    const resolution = resolveProviderSelection(inputs({ landofile: pid("podman"), config: pid("docker") }));
    expect(String(resolution.providerId)).toBe("podman");
    expect(resolution.source).toBe("landofile");
  });

  test("landofile wins over capability default", () => {
    const resolution = resolveProviderSelection(inputs({ landofile: pid("docker") }));
    expect(String(resolution.providerId)).toBe("docker");
    expect(resolution.source).toBe("landofile");
  });

  test("flag wins over landofile", () => {
    const resolution = resolveProviderSelection(inputs({ flag: pid("podman"), landofile: pid("docker") }));
    expect(String(resolution.providerId)).toBe("podman");
    expect(resolution.source).toBe("flag");
  });

  test("flag wins over env", () => {
    const resolution = resolveProviderSelection(inputs({ flag: pid("docker"), env: pid("podman") }));
    expect(String(resolution.providerId)).toBe("docker");
    expect(resolution.source).toBe("flag");
  });

  test("flag wins over config", () => {
    const resolution = resolveProviderSelection(inputs({ flag: pid("docker"), config: pid("podman") }));
    expect(String(resolution.providerId)).toBe("docker");
    expect(resolution.source).toBe("flag");
  });

  test("flag wins over capability default", () => {
    const resolution = resolveProviderSelection(inputs({ flag: pid("podman") }));
    expect(String(resolution.providerId)).toBe("podman");
    expect(resolution.source).toBe("flag");
  });

  test("flag wins when every input is set", () => {
    const resolution = resolveProviderSelection({
      flag: pid("podman"),
      landofile: pid("docker"),
      env: pid("lando"),
      config: pid("docker"),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    });
    expect(String(resolution.providerId)).toBe("podman");
    expect(resolution.source).toBe("flag");
    expect(String(resolution.inputs.flag)).toBe("podman");
    expect(String(resolution.inputs.landofile)).toBe("docker");
    expect(String(resolution.inputs.env)).toBe("lando");
    expect(String(resolution.inputs.config)).toBe("docker");
    expect(String(resolution.inputs.capabilityDefault)).toBe("lando");
  });

  test("preserves every input in the resolution regardless of which source wins", () => {
    const resolution = resolveProviderSelection({
      landofile: pid("docker"),
      env: pid("podman"),
      config: pid("lando"),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    });
    expect(resolution.source).toBe("landofile");
    expect(String(resolution.inputs.env)).toBe("podman");
    expect(String(resolution.inputs.config)).toBe("lando");
  });
});

describe("readProviderEnvVar", () => {
  test("returns undefined when LANDO_PROVIDER is unset", () => {
    expect(readProviderEnvVar({})).toBeUndefined();
  });

  test("returns undefined when LANDO_PROVIDER is empty string", () => {
    expect(readProviderEnvVar({ LANDO_PROVIDER: "" })).toBeUndefined();
  });

  test("returns ProviderId when LANDO_PROVIDER is set", () => {
    const value = readProviderEnvVar({ LANDO_PROVIDER: "podman" });
    expect(value).toBeDefined();
    expect(String(value)).toBe("podman");
  });

  test("does NOT read LANDO_DEFAULT_PROVIDER_ID (that is the config-overlay env)", () => {
    expect(readProviderEnvVar({ LANDO_DEFAULT_PROVIDER_ID: "podman" })).toBeUndefined();
  });
});
