import { afterEach, expect, test } from "bun:test";
import {
  createStandaloneRedactor,
  registerRedactionValues,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import {
  ArtifactBuildError,
  ArtifactTransferError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderSetupConsentDeniedError,
  ProviderSetupPrivilegeUnavailableError,
  ProviderSetupProvisioningError,
  ProviderSetupUnsupportedHostError,
  ProviderUnavailableError,
  ServiceCopyError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceRestartWouldRecreateError,
  ServiceStartError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { assertRedactedError } from "./fixtures/assert-redacted-error.ts";
import { canary, errorFields, plan, registryLayer, target } from "./fixtures/error-registry.ts";
import { memberError } from "./fixtures/failing-provider.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

const errorCase = <E extends ProviderError, I>(schema: Schema.Codec<E, I>, original: E) => ({
  original,
  encode: (error: ProviderError) => Schema.encodeUnknownSync(schema)(error),
});
const setupFields = {
  providerId: ProviderId.make("test"),
  message: errorFields.message,
  remediation: errorFields.remediation,
};
const cases = {
  ProviderUnavailableError: errorCase(ProviderUnavailableError, new ProviderUnavailableError(errorFields)),
  ProviderCapabilityError: errorCase(
    ProviderCapabilityError,
    new ProviderCapabilityError({
      ...errorFields,
      capability: canary,
      requiredValue: { value: [canary] },
      actualValue: canary,
    }),
  ),
  ProviderConfigError: errorCase(ProviderConfigError, new ProviderConfigError(errorFields)),
  ProviderInternalError: errorCase(ProviderInternalError, new ProviderInternalError(errorFields)),
  ArtifactBuildError: errorCase(ArtifactBuildError, new ArtifactBuildError(errorFields)),
  ServiceStartError: errorCase(ServiceStartError, memberError),
  ServiceExecError: errorCase(ServiceExecError, new ServiceExecError({ ...errorFields, service: canary })),
  ServiceNotFoundError: errorCase(
    ServiceNotFoundError,
    new ServiceNotFoundError({ ...errorFields, service: canary }),
  ),
  ServiceRestartWouldRecreateError: errorCase(
    ServiceRestartWouldRecreateError,
    new ServiceRestartWouldRecreateError({ ...errorFields, service: canary, reason: "config" }),
  ),
  VolumeOperationError: errorCase(
    VolumeOperationError,
    new VolumeOperationError({ ...errorFields, store: canary }),
  ),
  ServiceCopyError: errorCase(ServiceCopyError, new ServiceCopyError({ ...errorFields, service: canary })),
  ArtifactTransferError: errorCase(
    ArtifactTransferError,
    new ArtifactTransferError({ ...errorFields, artifactRef: canary }),
  ),
  ProviderSetupConsentDeniedError: errorCase(
    ProviderSetupConsentDeniedError,
    new ProviderSetupConsentDeniedError({ ...setupFields, change: "install-uidmap" }),
  ),
  ProviderSetupPrivilegeUnavailableError: errorCase(
    ProviderSetupPrivilegeUnavailableError,
    new ProviderSetupPrivilegeUnavailableError({ ...setupFields, change: "provision-subuid" }),
  ),
  ProviderSetupProvisioningError: errorCase(
    ProviderSetupProvisioningError,
    new ProviderSetupProvisioningError({
      ...setupFields,
      change: "provision-subgid",
      stage: "install",
      exitCode: 7,
      stderr: canary,
    }),
  ),
  ProviderSetupUnsupportedHostError: errorCase(
    ProviderSetupUnsupportedHostError,
    new ProviderSetupUnsupportedHostError({
      ...setupFields,
      prerequisite: canary,
      host: { id: canary, versionId: canary },
    }),
  ),
} satisfies {
  readonly [K in ProviderError["_tag"]]: {
    readonly original: Extract<ProviderError, { readonly _tag: K }>;
    readonly encode: (error: ProviderError) => unknown;
  };
};

test.each(Object.entries(cases))(
  "%s reconstruction preserves its schema and yieldability",
  async (_tag, { original, encode }) => {
    // Given
    const provider = { ...TestRuntimeProvider, start: () => Effect.fail(original) };
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerRedactionValues([canary]);
        const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
        return yield* Effect.result(selected.start(target));
      }).pipe(Effect.provide(registryLayer(provider))),
    );
    // Then
    if (Result.isSuccess(result)) throw new Error("Expected provider failure");
    await assertRedactedError(result.failure, original);
    const encoded = JSON.stringify(encode(result.failure));
    expect(createStandaloneRedactor("secrets").redactValue(encode(original))).toEqual(encode(result.failure));
    expect(encoded).not.toContain(canary);
    expect(encoded).toContain("[redacted]");
  },
);
