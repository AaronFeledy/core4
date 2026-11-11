import { expect, test } from "bun:test";
import { ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Schema } from "effect";

const fields = {
  providerId: "test",
  operation: "test",
  message: "Failed",
  remediation: "Retry",
};

test("provider diagnostic constructors accept only JSON values", () => {
  const invalidDetails = () =>
    new ProviderUnavailableError({
      ...fields,
      // @ts-expect-error Provider diagnostic details must be JSON, not a callable.
      details: { hook: () => "unsafe" },
    });
  const invalidRequired = () =>
    new ProviderCapabilityError({
      ...fields,
      capability: "test",
      // @ts-expect-error Required capability values must be JSON.
      requiredValue: undefined,
    });
  const invalidActual = () =>
    new ProviderCapabilityError({
      ...fields,
      capability: "test",
      requiredValue: true,
      // @ts-expect-error Actual capability values must be JSON when present.
      actualValue: { value: undefined },
    });

  expect(invalidDetails).toThrow();
  expect(invalidRequired).toThrow();
  expect(invalidActual).toThrow();
  const error = new ProviderCapabilityError({ ...fields, capability: "test", requiredValue: true });
  expect(error).not.toHaveProperty("actualValue");
  expect(
    Schema.is(ProviderUnavailableError)({ ...fields, _tag: "ProviderUnavailableError", details: 1n }),
  ).toBe(false);
});
