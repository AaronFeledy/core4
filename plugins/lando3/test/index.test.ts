import { describe, expect, test } from "bun:test";

import { createRedactor } from "@lando/sdk/secrets";

import { type Lando3TranslatorPorts, makeConfigTranslators, makeLando3Plugin } from "../src/index.ts";

const ports: Lando3TranslatorPorts = {
  decomposers: new Map(),
  redactor: createRedactor("secrets"),
};

describe("lando3 plugin ports", () => {
  test("resolves a provider only once per loader invocation, not per assertion", async () => {
    // Given: construction must not resolve host ports.
    let calls = 0;
    const module = makeLando3Plugin(() => {
      calls += 1;
      return ports;
    });
    expect(calls).toBe(0);
    const loader = module.configTranslators?.get("lando3");
    if (loader === undefined) throw new Error("Missing lando3 loader");

    // When: the loader is explicitly invoked.
    const translator = await loader();

    // Then: inspecting the result does not invoke the provider again.
    expect(calls).toBe(1);
    expect(translator.id).toBe("lando3");
    expect(translator.id).toBe("lando3");
    expect(calls).toBe(1);
    // Loaders are not memoized: a second invocation resolves ports again.
    expect((await loader()).id).toBe("lando3");
    expect(calls).toBe(2);
  });

  test("awaits asynchronous ports in the standalone translator loader", async () => {
    // Given: an asynchronous host provider.
    let calls = 0;
    const loaders = makeConfigTranslators(async () => {
      calls += 1;
      return ports;
    });
    expect(calls).toBe(0);
    // When: the frontend is requested.
    const translator = await loaders.get("lando3")?.();
    // Then: the provider was resolved lazily.
    expect(calls).toBe(1);
    expect(translator?.id).toBe("lando3");
  });

  test("accepts plain object ports", async () => {
    // Given: a host with already assembled ports.
    const module = makeLando3Plugin(ports);
    // When: its frontend is loaded.
    const translator = await module.configTranslators?.get("lando3")?.();
    // Then: the existing object API still works.
    expect(translator?.id).toBe("lando3");
  });

  test("uses default ports when none are supplied", async () => {
    // Given: a standalone plugin without host composition.
    const module = makeLando3Plugin();
    // When: its frontend is loaded.
    const translator = await module.configTranslators?.get("lando3")?.();
    // Then: the default translator remains usable.
    expect(translator?.id).toBe("lando3");
  });
});
