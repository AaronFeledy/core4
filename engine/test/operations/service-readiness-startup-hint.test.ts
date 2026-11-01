import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { REDACTED } from "@lando/sdk/secrets";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { type ReadinessTarget, failReadiness } from "../../src/operations/service-readiness-error.ts";
import { failureOf, secret } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each(["not-running", "healthcheck-failed", "healthcheck-timeout"] as const)(
  "appends the failing service's redacted hint when readiness reports %s",
  async (reason) => {
    // Given service-type advice containing a registered secret.
    const hint = `Configure the authored launcher with --token ${secret}.`;
    const target: ReadinessTarget = {
      provider: TestRuntimeProvider,
      plan: { ...plan, services: { [web.name]: { ...web, startupFailureHint: hint } } },
      service: web.name,
    };
    const baseline = failureOf(await Effect.runPromiseExit(failReadiness({ ...target, plan }, { reason })));
    const redaction = makeRedactionService();
    await Effect.runPromise(redaction.registerValues([secret]));

    // When the readiness failure is reported through the normal redactor.
    const error = failureOf(
      await Effect.runPromiseExit(
        failReadiness(target, { reason }).pipe(Effect.provideService(RedactionService, redaction)),
      ),
    );

    // Then existing remediation survives and advice is a separate, redacted sentence.
    expect(error.remediation).toBe(
      `${baseline.remediation} Configure the authored launcher with --token ${REDACTED}.`,
    );
    expect(JSON.stringify(error)).not.toContain(secret);
  },
);

test("omits launcher advice when provider inspection fails", async () => {
  // Given a service with launcher advice.
  const target: ReadinessTarget = {
    provider: TestRuntimeProvider,
    plan: { ...plan, services: { [web.name]: { ...web, startupFailureHint: "Configure the launcher." } } },
    service: web.name,
  };

  // When provider inspection fails rather than service startup.
  const error = failureOf(await Effect.runPromiseExit(failReadiness(target, { reason: "inspect-failed" })));

  // Then remediation remains provider-focused.
  expect(error.remediation).toBe(
    "Run `lando doctor` to diagnose and restore the provider, then retry start.",
  );
});
