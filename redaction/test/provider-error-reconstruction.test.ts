import { expect, test } from "bun:test";
import { taggedErrorJson } from "@lando/sdk/command-result";
import * as Errors from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { isProviderError, redactProviderError } from "../src/provider-error.ts";
import { createStandaloneRedactor } from "../src/service.ts";

const canary = "authoritative-provider-canary";
const text = { message: canary, remediation: canary };
const base = { ...text, providerId: canary, operation: canary, details: { [canary]: canary }, cause: canary };
const setup = { ...text, providerId: ProviderId.make(canary), change: "install-uidmap" as const };
const errors = [
  new Errors.ProviderUnavailableError(base),
  new Errors.ProviderConfigError(base),
  new Errors.ProviderInternalError(base),
  new Errors.ArtifactBuildError(base),
  new Errors.ProviderCapabilityError({
    ...base,
    capability: canary,
    requiredValue: canary,
    actualValue: canary,
  }),
  new Errors.ServiceExecError({ ...base, service: canary }),
  new Errors.ServiceNotFoundError({ ...base, service: canary }),
  new Errors.ServiceRestartWouldRecreateError({ ...base, service: canary, reason: "config" }),
  new Errors.ServiceStartError({
    ...base,
    service: canary,
    logTail: { ...{ extra: canary }, service: canary, lines: [canary], truncated: false },
    listener: {
      ...{ extra: canary },
      service: canary,
      port: 80,
      transport: "tcp",
      basis: "probe-target",
      state: "listening",
      listening: [{ ...{ extra: canary }, address: canary, port: 80 }],
    },
  }),
  new Errors.VolumeOperationError({ ...base, store: canary }),
  new Errors.ServiceCopyError({ ...base, service: canary }),
  new Errors.ArtifactTransferError({ ...base, artifactRef: canary }),
  new Errors.SecretNotFoundError({ ...text, secret: canary }),
  new Errors.SecretReferenceInvalidError({ ...text, reference: canary }),
  new Errors.SecretStoreUnavailableError({ ...text, storeId: canary, reason: "locked" }),
  new Errors.EnvironmentValueResolutionError({
    ...text,
    variable: canary,
    reference: canary,
    reason: "invalid-value",
  }),
  new Errors.PlanReplanRequiredError({ ...base, app: canary, valueModel: 1 }),
  new Errors.HealthcheckTargetUnsupportedError({
    ...text,
    service: canary,
    target: "service",
    role: "readiness",
  }),
  new Errors.ProviderSetupConsentDeniedError(setup),
  new Errors.ProviderSetupPrivilegeUnavailableError(setup),
  new Errors.ProviderSetupProvisioningError({ ...setup, stage: "install", stderr: canary, cause: canary }),
  new Errors.ProviderSetupUnsupportedHostError({
    ...setup,
    prerequisite: canary,
    host: { id: canary, versionId: canary },
  }),
] satisfies readonly ProviderError[];

test.each(errors)("reconstructs $_tag without credential fields or nested cause", (error) => {
  const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: [canary] });
  const safe = redactProviderError(error, redactor, { cause: "omit" });
  expect(isProviderError(safe)).toBe(true);
  expect(safe._tag).toBe(error._tag);
  expect(safe).not.toHaveProperty("cause");
  expect(JSON.stringify(safe)).not.toContain(canary);
  expect(JSON.stringify(safe)).not.toContain('"cause"');
  expect(JSON.stringify(taggedErrorJson(safe))).not.toContain(canary);
  expect(taggedErrorJson(safe)).not.toHaveProperty("cause");
  const kept = redactProviderError(error, redactor);
  if ("cause" in error) expect(kept).toHaveProperty("cause", error.cause);
});

test("rejects unknown tags and incomplete provider-shaped objects", () => {
  expect(isProviderError({ ...base, _tag: "UntrustedError" })).toBe(false);
  expect(isProviderError({ _tag: "ProviderUnavailableError", message: canary })).toBe(false);
});
