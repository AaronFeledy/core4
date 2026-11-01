import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { PortNumber } from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { type ReadinessTarget, failReadiness } from "../../src/operations/service-readiness-error.ts";
import { failureOf, secret } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const authorityWithSecret = {
  owner: "launcher" as const,
  daemon: "web",
  port: PortNumber.make(3000),
  setting: `--token ${secret}`,
};

test.each(["healthcheck-failed", "healthcheck-timeout"] as const)(
  "leads with the failing service's redacted listener authority without observation for %s",
  async (reason) => {
    // Given structured authority containing a registered secret in its setting.
    const target: ReadinessTarget = {
      provider: TestRuntimeProvider,
      plan: { ...plan, services: { [web.name]: { ...web, listenerAuthority: authorityWithSecret } } },
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

    // Then existing remediation survives and authority advice is a separate, redacted sentence.
    expect(error.remediation).toBe(
      `Pass \`--token ${REDACTED}\` to web in your command or entrypoint; Lando sets the listener from port: only in its own launcher.\n${baseline.remediation}`,
    );
    expect(JSON.stringify(error)).not.toContain(secret);
  },
);

test("omits listener authority when the process is not running", async () => {
  const target: ReadinessTarget = {
    provider: TestRuntimeProvider,
    plan: { ...plan, services: { [web.name]: { ...web, listenerAuthority: authorityWithSecret } } },
    service: web.name,
  };
  const error = failureOf(await Effect.runPromiseExit(failReadiness(target, { reason: "not-running" })));
  expect(error.remediation).toBe(
    "Run `lando logs -s web` to diagnose the service and fix it. Then retry `lando start`.",
  );
});

test("omits listener authority advice when provider inspection fails", async () => {
  // Given a service with listener authority.
  const target: ReadinessTarget = {
    provider: TestRuntimeProvider,
    plan: {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          listenerAuthority: {
            owner: "launcher",
            daemon: "web",
            port: PortNumber.make(3000),
            setting: "--port 3000",
          },
        },
      },
    },
    service: web.name,
  };

  // When provider inspection fails rather than service startup.
  const error = failureOf(await Effect.runPromiseExit(failReadiness(target, { reason: "inspect-failed" })));

  // Then remediation remains provider-focused.
  expect(error.remediation).toBe(
    "Run `lando doctor` to diagnose and restore the provider, then retry start.",
  );
});
