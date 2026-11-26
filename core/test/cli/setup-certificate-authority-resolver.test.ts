import { describe, expect, test } from "bun:test";
import { makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import { CommandWarnings, makeCommandWarnings } from "@lando/engine/landofile/command-warnings";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";

import { EventError, NoCertificateAuthorityError } from "@lando/sdk/errors";
import { HostChangeId, type TrustStoreChange } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  type CertificateAuthorityShape,
  EventService,
  type LandoEvent,
} from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { type Context, Effect } from "effect";
import { planCaHostChanges, runCaSetupStep } from "../../src/cli/command-specs/meta/setup-ca-step.ts";
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

const applier = makeHostChangeApplier({ proposals: [], approved: new Set(), redact: String }).applier;
const NOT_APPROVED = { applier, trustApproved: false };
const TRUST_APPROVED = { applier, trustApproved: true };

describe("CA setup resolver", () => {
  test("resolves and sets up the selected authority", async () => {
    // Given
    const ca = makeTestCertificateAuthority();
    const { recorder, steps } = makeRecorder();

    // When
    await Effect.runPromise(
      runCaSetupStep({}, NOT_APPROVED, recorder).pipe(
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
      setup: () => processRunner.run().pipe(Effect.as({ trustStores: [] })),
    };
    const eventService = EventService.of({
      publish: (event: { readonly _tag: string; readonly body?: string }) =>
        Effect.sync(() => {
          sequence.push(`event: ${event.body ?? event._tag}`);
        }),
    } as unknown as Context.Service.Shape<typeof EventService>);
    const { recorder } = makeRecorder();

    await Effect.runPromise(
      runCaSetupStep({}, TRUST_APPROVED, recorder, "lando", "win32").pipe(
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

  const SYSTEM: TrustStoreChange = {
    id: "system",
    name: "System trust store",
    state: "trusted",
    changed: true,
  };
  const BREW: TrustStoreChange = {
    id: "homebrew",
    name: "Homebrew CA bundle",
    location: "/b/cert.pem",
    state: "untrusted",
    reason: "refresh-failed",
    detail: "`brew postinstall ca-certificates` failed: Permission denied",
    remediation: "Fix the Homebrew error, then run `lando setup` again.",
    changed: false,
  };
  const UNKNOWN: TrustStoreChange = {
    id: "nss",
    name: "NSS database",
    state: "unknown",
    reason: "inspection-failed",
    changed: false,
  };
  const NSS: TrustStoreChange = {
    id: "nss",
    name: "NSS database",
    location: "/home/u/.pki/nssdb",
    state: "trusted",
    detail: "Restart Chrome or Chromium to use it.",
    changed: true,
  };
  const reporting = (trustStores: ReadonlyArray<TrustStoreChange>) => ({
    ...makeTestCertificateAuthority(),
    setup: () => Effect.succeed({ trustStores }),
  });

  test("returns the trust stores, narrates changes, and warns about each store left untrusted", async () => {
    // Given: setup trusted the system store and could not repair two others
    const ca = reporting([SYSTEM, NSS, BREW, UNKNOWN]);
    const events: LandoEvent[] = [];
    const commandWarnings = makeCommandWarnings(true);
    const { recorder, steps } = makeRecorder();

    // When
    const stores = await Effect.runPromise(
      runCaSetupStep({}, NOT_APPROVED, recorder).pipe(
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({ resolve: Effect.succeed(ca) }),
        ),
        Effect.provideService(EventService, makeTestEventService(events)),
        Effect.provideService(CommandWarnings, commandWarnings),
      ),
    );

    // Then
    expect(stores).toEqual([SYSTEM, NSS, BREW, UNKNOWN]);
    expect(events.flatMap((event) => (event._tag === "message.info" ? [event.body] : []))).toEqual([
      "Trusted the local CA in System trust store.",
      "Trusted the local CA in NSS database (/home/u/.pki/nssdb). Restart Chrome or Chromium to use it.",
    ]);
    // Machine output carries the warnings in the envelope instead of narrating them.
    expect(events.filter((event) => event._tag === "message.warn")).toEqual([]);
    expect(await Effect.runPromise(commandWarnings.list)).toEqual([
      {
        code: "CA_TRUST_INCOMPLETE",
        message:
          "Homebrew CA bundle at /b/cert.pem does not trust the local CA: `brew postinstall ca-certificates` failed: Permission denied.",
        remediation: "Fix the Homebrew error, then run `lando setup` again.",
        context: { store: "homebrew", location: "/b/cert.pem", state: "untrusted", reason: "refresh-failed" },
      },
      {
        code: "CA_TRUST_INCOMPLETE",
        message: "NSS database does not trust the local CA.",
        context: { store: "nss", state: "unknown", reason: "inspection-failed" },
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: "ca", status: "satisfied", remediation: BREW.remediation });
    expect(steps[0]?.evidence).toContain("Homebrew CA bundle (/b/cert.pem): untrusted.");
  });

  test("narrates trust warnings to people and still records them when narration fails", async () => {
    // Given: an event bus that rejects every publish
    const ca = reporting([BREW]);
    const published: string[] = [];
    const failingEvents = EventService.of({
      ...makeTestEventService([]),
      publish: (event) =>
        Effect.sync(() => void published.push(event._tag)).pipe(
          Effect.andThen(
            Effect.fail(
              new EventError({
                message: "renderer is gone",
                event: "message.warn",
                remediation: "Restart the renderer.",
              }),
            ),
          ),
        ),
    });
    const commandWarnings = makeCommandWarnings(false);
    const { recorder, steps } = makeRecorder();

    // When
    const exit = await Effect.runPromiseExit(
      runCaSetupStep({}, NOT_APPROVED, recorder).pipe(
        Effect.provideService(CertificateAuthority, ca),
        Effect.provideService(EventService, failingEvents),
        Effect.provideService(CommandWarnings, commandWarnings),
      ),
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(published).toEqual(["message.warn"]);
    expect((await Effect.runPromise(commandWarnings.list)).map(({ code }) => code)).toEqual([
      "CA_TRUST_INCOMPLETE",
    ]);
    expect(steps[0]).toMatchObject({ id: "ca", status: "satisfied" });
  });

  test("reports untrusted stores without warnings when skip-install-ca is set", async () => {
    // Given
    const ca = reporting([{ ...SYSTEM, state: "untrusted", changed: false }, BREW]);
    const commandWarnings = makeCommandWarnings(true);
    const { recorder, steps } = makeRecorder();

    // When
    const stores = await Effect.runPromise(
      runCaSetupStep({ flags: { "skip-install-ca": true } }, NOT_APPROVED, recorder).pipe(
        Effect.provideService(CertificateAuthority, ca),
        Effect.provideService(CommandWarnings, commandWarnings),
      ),
    );

    // Then
    expect(stores?.map(({ id }) => id)).toEqual(["system", "homebrew"]);
    expect(await Effect.runPromise(commandWarnings.list)).toEqual([]);
    expect(steps[0]).toMatchObject({ id: "ca", status: "skipped" });
    expect(steps[0]?.remediation).toBeUndefined();
  });

  test("returns no trust stores when no authority ran", async () => {
    const { recorder } = makeRecorder();

    const stores = await Effect.runPromise(runCaSetupStep({}, NOT_APPROVED, recorder));

    expect(stores).toBeUndefined();
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
      runCaSetupStep({}, NOT_APPROVED, recorder).pipe(
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
      runCaSetupStep({ flags: { "skip-install-ca": true } }, NOT_APPROVED, recorder).pipe(
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
    expect(ca.calls).toEqual([
      { op: "setup", opts: { force: false, hostChanges: applier, skipTrustInstall: true } },
    ]);
    expect(steps.map(({ status }) => status)).toEqual(["skipped"]);
  });

  test("a Windows run that did not approve trust does not announce a Security Warning", async () => {
    const bodies: string[] = [];
    const eventService = EventService.of({
      publish: (event: { readonly body?: string }) => Effect.sync(() => void bodies.push(event.body ?? "")),
    } as unknown as Context.Service.Shape<typeof EventService>);
    const { recorder } = makeRecorder();

    await Effect.runPromise(
      runCaSetupStep({}, NOT_APPROVED, recorder, "lando", "win32").pipe(
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({ resolve: Effect.succeed(makeTestCertificateAuthority()) }),
        ),
        Effect.provideService(EventService, eventService),
      ),
    );

    expect(bodies.filter((body) => body.includes("Security Warning"))).toEqual([]);
  });
});

describe("planning the CA's host changes", () => {
  const proposal = {
    change: {
      id: HostChangeId.make("test:trust"),
      owner: "@lando/test",
      stage: "ca",
      summary: "Trust the test CA",
      reason: "Tests.",
      consent: "standard",
      persistent: false,
      requirement: "recommended",
      steps: [{ id: "trust", summary: "Trust", argv: ["/bin/true"], privileged: true, when: "always" }],
      undo: { _tag: "none", detail: "Nothing to undo." },
    },
    apply: () => Effect.succeed({ changed: true }),
  } as const;
  const withAuthority = (planHostChanges: NonNullable<CertificateAuthorityShape["planHostChanges"]>) =>
    Effect.provideService(
      CertificateAuthorityResolver,
      CertificateAuthorityResolver.of({
        resolve: Effect.succeed({ ...makeTestCertificateAuthority(), planHostChanges }),
      }),
    );

  test("joins the authority's proposals to setup's plan", async () => {
    const { recorder } = makeRecorder();
    const planned = await Effect.runPromise(
      planCaHostChanges({}, recorder).pipe(withAuthority(Effect.succeed([proposal]))),
    );
    expect(planned.map(({ change }) => change.id)).toEqual([proposal.change.id]);
  });

  test("plans nothing with --skip-install-ca or when no authority resolves", async () => {
    const { recorder, steps } = makeRecorder();
    const skipped = await Effect.runPromise(
      planCaHostChanges({ flags: { "skip-install-ca": true } }, recorder).pipe(
        withAuthority(Effect.die("planning must not run")),
      ),
    );
    const unresolved = await Effect.runPromise(
      planCaHostChanges({}, recorder).pipe(
        Effect.provideService(
          CertificateAuthorityResolver,
          CertificateAuthorityResolver.of({
            resolve: Effect.fail(
              new NoCertificateAuthorityError({
                message: "none",
                candidates: [],
                remediation: "install one",
              }),
            ),
          }),
        ),
      ),
    );
    expect([skipped, unresolved]).toEqual([[], []]);
    expect(steps).toEqual([]);
  });
});
