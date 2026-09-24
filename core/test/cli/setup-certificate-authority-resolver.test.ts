import { describe, expect, test } from "bun:test";

import { type Context, Effect } from "effect";

import { NoCertificateAuthorityError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { runCaSetupStep } from "../../src/cli/command-specs/meta/setup-service-steps.ts";
import type { SetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import type { SetupReadinessStep } from "../../src/cli/commands/setup-readiness.ts";

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

  test("announces a possible Windows trust prompt before the mkcert process starts", async () => {
    const sequence: string[] = [];
    const processRunner = {
      run: () =>
        Effect.sync(() => {
          sequence.push("mkcert -install");
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    };
    const ca = {
      ...makeTestCertificateAuthority(),
      setup: () => processRunner.run().pipe(Effect.asVoid),
    };
    const eventService = {
      publish: (event: { readonly _tag: string; readonly body?: string }) =>
        Effect.sync(() => {
          sequence.push(`event: ${event.body ?? event._tag}`);
        }),
    } as unknown as Context.Tag.Service<typeof EventService>;
    const { recorder } = makeRecorder();

    await Effect.runPromise(
      runCaSetupStep({}, {}, recorder, "lando", "win32").pipe(
        Effect.provideService(CertificateAuthorityResolver, { resolve: Effect.succeed(ca) }),
        Effect.provideService(EventService, eventService),
      ),
    );

    expect(sequence).toHaveLength(2);
    expect(sequence[0]).toContain("Windows may open a Security Warning");
    expect(sequence[0]).toContain("--yes cannot answer Windows security prompts");
    expect(sequence[1]).toBe("mkcert -install");
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
