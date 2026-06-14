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

  test("validates declared service type static map entries", async () => {
    await expectPluginContractFailure(
      {
        manifest: {
          ...TestPluginManifest,
          contributes: { serviceTypes: ["node:lts"] },
        },
        layers: { services: Layer.empty },
      },
      "serviceTypes static map contains declared id node:lts",
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

const CORE_COMPATIBILITY_ASSERTION = 'manifest requires "@lando/core" "^4.0.0" for Beta 1 compatibility';

const runCoreContract = (manifest: unknown) =>
  runPluginContract({ manifest, layers: { logger: Layer.empty } });

const expectCoreContractFailure = async (manifest: unknown, reason: string): Promise<void> => {
  const result = await Effect.runPromiseExit(runCoreContract(manifest));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  const error = result.cause.error;
  expect(error).toBeInstanceOf(ContractFailure);
  expect(error._tag).toBe("ContractFailure");
  expect(error.assertion).toBe(CORE_COMPATIBILITY_ASSERTION);
  const details = error.details as { reason?: string; remediation?: string } | undefined;
  expect(details?.reason).toBe(reason);
  expect(details?.remediation).toBe('Set requires["@lando/core"] to "^4.0.0".');
};

const manifestWithRequires = (requires: Record<string, string> | undefined): PluginManifest => {
  const { requires: _omitted, ...base } = TestPluginManifest;
  return (requires === undefined ? base : { ...base, requires }) as PluginManifest;
};

describe("runPluginContract @lando/core compatibility", () => {
  test("accepts a manifest declaring the canonical ^4.0.0 core range", async () => {
    await expect(Effect.runPromise(runCoreContract(TestPluginManifest))).resolves.toBeUndefined();
  });

  test("accepts the canonical range with surrounding whitespace", async () => {
    await expect(
      Effect.runPromise(runCoreContract(manifestWithRequires({ "@lando/core": "  ^4.0.0  " }))),
    ).resolves.toBeUndefined();
  });

  test("rejects a manifest with no requires block as missing", async () => {
    await expectCoreContractFailure(manifestWithRequires(undefined), "missing");
  });

  test("rejects a requires block without an @lando/core entry as missing", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/sdk": "^4.0.0" }), "missing");
  });

  test("rejects a blank @lando/core range as missing", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/core": "  " }), "missing");
  });

  test("rejects an older core major as incompatible", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/core": "^3.0.0" }), "incompatible");
  });

  test("rejects a newer core major as incompatible", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/core": "^5.0.0" }), "incompatible");
  });

  test("rejects a non-canonical equivalent range as incompatible", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/core": "4.x" }), "incompatible");
  });

  test("rejects a wildcard range as overly broad", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/core": "*" }), "overly-broad");
  });

  test("rejects an open-ended comparator range as overly broad", async () => {
    await expectCoreContractFailure(manifestWithRequires({ "@lando/core": ">=4" }), "overly-broad");
  });
});
