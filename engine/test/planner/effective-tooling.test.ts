import { describe, expect, test } from "bun:test";

import { type LandofileShape, PortablePath } from "@lando/sdk/schema";

import { compileEffectiveTooling } from "../../src/planner/effective-tooling.ts";

describe("compileEffectiveTooling", () => {
  test("authored tasks win wholesale over service-type tasks", () => {
    // Given
    const landofile: LandofileShape = {
      toolingDefaults: { service: "fallback", env: { DEFAULT_ONLY: "default" } },
      tooling: { inspect: { cmd: "authored", description: "authored task" } },
    };

    // When
    const tooling = compileEffectiveTooling({
      landofile,
      services: [
        {
          name: "web",
          tooling: {
            inspect: { cmd: "service", description: "service task", env: { SERVICE_ONLY: "service" } },
          },
        },
      ],
    });

    // Then
    expect(tooling.inspect).toEqual({
      cmd: "authored",
      description: "authored task",
      service: "fallback",
      env: { DEFAULT_ONLY: "default" },
    });
  });

  test("the lexicographically first service owns a same-tier task", () => {
    // Given / When
    const tooling = compileEffectiveTooling({
      landofile: {},
      services: [
        { name: "zeta", tooling: { inspect: { cmd: "from-zeta" } } },
        { name: "alpha", tooling: { inspect: { cmd: "from-alpha" } } },
      ],
    });

    // Then
    expect(tooling.inspect).toEqual({ cmd: "from-alpha", service: "alpha" });
  });

  test("defaults fill only after service contribution merge", () => {
    // Given / When
    const tooling = compileEffectiveTooling({
      landofile: {
        toolingDefaults: {
          service: "fallback",
          dir: PortablePath.make("/workspace/default"),
          env: { DEFAULT_ONLY: "default", SHARED: "default" },
          vars: { DEFAULT_VAR: "default", SHARED_VAR: "default" },
        },
      },
      services: [
        {
          name: "worker",
          tooling: {
            inspect: {
              cmd: "env",
              env: { SERVICE_ONLY: "service", SHARED: "service" },
              vars: { SERVICE_VAR: "service", SHARED_VAR: "service" },
            },
          },
        },
      ],
    });

    // Then
    expect(tooling.inspect).toEqual({
      cmd: "env",
      service: "worker",
      dir: PortablePath.make("/workspace/default"),
      env: { DEFAULT_ONLY: "default", SERVICE_ONLY: "service", SHARED: "service" },
      vars: { DEFAULT_VAR: "default", SERVICE_VAR: "service", SHARED_VAR: "service" },
    });
  });
});
