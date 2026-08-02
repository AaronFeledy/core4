import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { NoCertificateAuthorityError } from "@lando/sdk/errors";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import type { SetupReadinessStep } from "../../src/cli/commands/setup-readiness.ts";
import { runCaSetupStep } from "../../src/cli/oclif/commands/meta/setup-service-steps.ts";
import type { SetupReadinessRecorder } from "../../src/cli/oclif/commands/meta/setup-steps.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";

const makeRecorder = () => {
  const steps: SetupReadinessStep[] = [];
  const record = (step: SetupReadinessStep) => Effect.sync(() => void steps.push(step));
  const recorder: SetupReadinessRecorder = {
    record,
    recordFailure: (id, cause) =>
      record({ id, status: "failed", evidence: String(cause), remediation: "retry setup" }),
    recordUnavailable: (id, serviceName) =>
      record({
        id,
        status: "unavailable",
        evidence: `${serviceName} setup service is not available.`,
        remediation: "install a certificate authority plugin",
      }),
    setRuntimeService: () => undefined,
  };
  return { recorder, steps };
};

describe("CA setup resolver", () => {
  test("resolves and sets up the selected authority", async () => {
    // Given
    const ca = makeTestCertificateAuthority();
    const { recorder, steps } = makeRecorder();

    // When
    await Effect.runPromise(
      runCaSetupStep({}, {}, recorder).pipe(
        Effect.provideService(CertificateAuthorityResolver, { resolve: Effect.succeed(ca) }),
      ),
    );

    // Then
    expect(ca.calls.map(({ op }) => op)).toEqual(["setup"]);
    expect(steps.map(({ status }) => status)).toEqual(["satisfied"]);
  });

  test("records tagged absence as unavailable without a defect", async () => {
    // Given
    const { recorder, steps } = makeRecorder();
    const unavailable = new NoCertificateAuthorityError({
      message: "No certificate authority is available.",
      candidates: [],
      remediation: "Install a certificate authority plugin.",
    });

    // When
    await Effect.runPromise(
      runCaSetupStep({}, {}, recorder).pipe(
        Effect.provideService(CertificateAuthorityResolver, { resolve: Effect.fail(unavailable) }),
      ),
    );

    // Then
    expect(steps.map(({ status }) => status)).toEqual(["unavailable"]);
    expect(steps[0]?.remediation).toContain("certificate authority plugin");
  });

  test("provisions the selected authority without installing trust when skip-install-ca is set", async () => {
    // Given
    let resolved = false;
    const ca = makeTestCertificateAuthority();
    const { recorder, steps } = makeRecorder();

    // When
    await Effect.runPromise(
      runCaSetupStep({ flags: { "skip-install-ca": true } }, {}, recorder).pipe(
        Effect.provideService(CertificateAuthorityResolver, {
          resolve: Effect.sync(() => {
            resolved = true;
            return ca;
          }),
        }),
      ),
    );

    // Then
    expect(resolved).toBe(true);
    expect(ca.calls).toEqual([{ op: "setup", opts: { force: false, skipTrustInstall: true } }]);
    expect(steps.map(({ status }) => status)).toEqual(["skipped"]);
  });
});
