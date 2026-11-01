import { expect, test } from "bun:test";
import { ServiceStartError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { redactProviderError } from "../../src/providers/error-redaction.ts";

test("provider error redaction keeps a dependency gate's listener observation", () => {
  // Given: a gate failure whose dependency name is also a registered secret.
  const listener = {
    service: "private-cache",
    port: 6380,
    transport: "tcp",
    basis: "primary-endpoint",
    state: "not-listening",
    listening: [{ address: "0.0.0.0", port: 6379 }],
  } as const;
  const error = new ServiceStartError({
    providerId: ProviderId.make("lando"),
    operation: "bringUp.schedule",
    service: "web",
    message: "Dependency private-cache: no TCP listener observed on 6380; observed ports: 6379.",
    remediation: "Make private-cache listen on 6380.",
    listener,
  });

  // When
  const redacted = redactProviderError(error, createRedactor("secrets", { values: ["private-cache"] }));

  // Then: the evidence survives, with its service name redacted like the rest of the error.
  expect(redacted).toBeInstanceOf(ServiceStartError);
  if (!(redacted instanceof ServiceStartError)) throw redacted;
  expect(redacted.listener).toEqual({ ...listener, service: "[redacted]" });
  expect(redacted.message).not.toContain("private-cache");
});
