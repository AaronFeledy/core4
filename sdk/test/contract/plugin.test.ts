import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";
import { ContractFailure, TestPluginManifest, runPluginContract } from "@lando/sdk/test";

const expectPluginContractFailure = async (
  input: Parameters<typeof runPluginContract>[0],
  assertion: string,
): Promise<void> => {
  const result = await Effect.runPromiseExit(runPluginContract(input));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("runPluginContract", () => {
  test("is exported as an Effect-returning contract helper", async () => {
    const contract = runPluginContract({
      manifest: TestPluginManifest,
      layers: { logger: Layer.empty },
    });

    expect(Effect.isEffect(contract)).toBe(true);
    await expect(Effect.runPromise(contract)).resolves.toBeUndefined();
  });

  test("fails with ContractFailure when a contributed layer is missing", async () => {
    await expectPluginContractFailure(
      {
        manifest: TestPluginManifest,
        layers: {},
      },
      "contribution loggers exposes Layer export logger",
    );
  });

  test("fails with ContractFailure when contribution ids are empty", async () => {
    await expectPluginContractFailure(
      {
        manifest: {
          ...TestPluginManifest,
          contributes: { loggers: [""] },
        } as PluginManifest,
        layers: { logger: Layer.empty },
      },
      "contribution loggers contains only non-empty ids",
    );
  });

  test("validates declared global service static map entries", async () => {
    await expectPluginContractFailure(
      {
        manifest: {
          ...TestPluginManifest,
          contributes: { globalServices: [{ id: "mailpit" }] },
        },
        globalServices: new Map(),
      },
      "globalServices static map contains declared id mailpit",
    );
  });

  test("validates declared template engine static map entries", async () => {
    await expectPluginContractFailure(
      {
        manifest: {
          ...TestPluginManifest,
          contributes: { templateEngines: ["handlebars"] },
        },
        layers: { templateEngine: Layer.empty },
      },
      "templateEngines static map contains declared id handlebars",
    );
  });
});
