import { describe, expect, test } from "bun:test";
import { CommandWarnings, makeCommandWarnings } from "@lando/engine/landofile/command-warnings";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";

import { EventError, NoCertificateAuthorityError } from "@lando/sdk/errors";
import { CertificateAuthority, EventService, type LandoEvent } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { type Context, Effect } from "effect";
import { runCaSetupStep } from "../../src/cli/command-specs/meta/setup-service-steps.ts";
import type { SetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import type { SetupReadinessStep } from "../../src/cli/commands/setup-readiness.ts";
import { makeTestEventService } from "../../src/testing/test-runtime-events.ts";

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
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({ resolve: Effect.succeed(ca) }),
        ),
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
      setup: () => processRunner.run().pipe(Effect.as({ refreshedBundles: [], warnings: [] })),
    };
    const eventService = EventService.of({
      publish: (event: { readonly _tag: string; readonly body?: string }) =>
        Effect.sync(() => {
          sequence.push(`event: ${event.body ?? event._tag}`);
        }),
    } as unknown as Context.Service.Shape<typeof EventService>);
    const { recorder } = makeRecorder();

    await Effect.runPromise(
      runCaSetupStep({}, {}, recorder, "lando", "win32").pipe(
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({ resolve: Effect.succeed(ca) }),
        ),
        Effect.provideService(EventService, eventService),
      ),
    );

    expect(sequence).toHaveLength(2);
    expect(sequence[0]).toContain("Windows may open a Security Warning");
    expect(sequence[0]).toContain("--yes cannot answer Windows security prompts");
    expect(sequence[1]).toBe("mkcert -install");
  });

  test("reports refreshed bundles and bundle warnings from authority setup", async () => {
    // Given: setup refreshed one bundle and could not refresh another
    const warning = {
      code: "CA_BUNDLE_STALE",
      message: "Homebrew's CA bundle at /b/cert.pem does not include the local CA.",
      remediation: "Fix the Homebrew error, then run `lando setup` again.",
      context: { bundle: "/b/cert.pem", owner: "Homebrew" },
    };
    const ca = {
      ...makeTestCertificateAuthority(),
      setup: () =>
        Effect.succeed({
          refreshedBundles: [{ owner: "Homebrew", path: "/a/cert.pem" }],
          warnings: [warning],
        }),
    };
    const events: LandoEvent[] = [];
    const eventService = makeTestEventService(events);
    const commandWarnings = makeCommandWarnings(true);
    const { recorder, steps } = makeRecorder();

    // When
    const refreshed = await Effect.runPromise(
      runCaSetupStep({}, {}, recorder).pipe(
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({ resolve: Effect.succeed(ca) }),
        ),
        Effect.provideService(EventService, eventService),
        Effect.provideService(CommandWarnings, commandWarnings),
      ),
    );

    // Then
    expect(refreshed).toEqual([{ owner: "Homebrew", path: "/a/cert.pem" }]);
    expect(events.flatMap((event) => (event._tag === "message.info" ? [event.body] : []))).toEqual([
      expect.stringContaining("/a/cert.pem"),
    ]);
    expect(await Effect.runPromise(commandWarnings.list)).toEqual([warning]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: "ca", status: "satisfied", remediation: warning.remediation });
    expect(steps[0]?.evidence).toContain("/a/cert.pem");
    expect(steps[0]?.evidence).toContain(warning.message);
  });

  test("records bundle warnings even when narrating them fails", async () => {
    // Given: an event bus that rejects every publish
    const warning = { code: "CA_BUNDLE_STALE", message: "stale", remediation: "Run `lando setup` again." };
    const ca = {
      ...makeTestCertificateAuthority(),
      setup: () => Effect.succeed({ refreshedBundles: [], warnings: [warning] }),
    };
    const failingEvents = EventService.of({
      ...makeTestEventService([]),
      publish: () =>
        Effect.fail(
          new EventError({
            message: "renderer is gone",
            event: "message.warn",
            remediation: "Restart the renderer.",
          }),
        ),
    });
    const commandWarnings = makeCommandWarnings(false);
    const { recorder, steps } = makeRecorder();

    // When
    const exit = await Effect.runPromiseExit(
      runCaSetupStep({}, {}, recorder).pipe(
        Effect.provideService(CertificateAuthority, ca),
        Effect.provideService(EventService, failingEvents),
        Effect.provideService(CommandWarnings, commandWarnings),
      ),
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(await Effect.runPromise(commandWarnings.list)).toEqual([warning]);
    expect(steps[0]).toMatchObject({ id: "ca", status: "satisfied" });
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
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({ resolve: Effect.fail(unavailable) }),
        ),
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
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({
            resolve: Effect.sync(() => {
              resolved = true;
              return ca;
            }),
          }),
        ),
      ),
    );

    // Then
    expect(resolved).toBe(true);
    expect(ca.calls).toEqual([{ op: "setup", opts: { force: false, skipTrustInstall: true } }]);
    expect(steps.map(({ status }) => status)).toEqual(["skipped"]);
  });
});
