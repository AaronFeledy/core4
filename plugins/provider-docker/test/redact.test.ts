import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { Effect } from "effect";

import { type DockerApiClient, makeRuntimeProvider } from "@lando/provider-docker";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

test.each([
  [500, "ProviderUnavailableError"],
  [200, "ProviderInternalError"],
] as const)("redacts runtime-registered values in list failures with HTTP %s", async (status, tag) => {
  // Given
  const canary = "opaque-docker-canary-1261";
  const redaction = makeRedactionService();
  const body =
    status === 500 ? JSON.stringify({ message: `engine said ${canary}` }) : `invalid JSON ${canary}`;
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: () => Effect.succeed({ status, body }),
  };
  const provider = await Effect.runPromise(
    makeRuntimeProvider({ platform: "linux", dockerApi: api }).pipe(
      Effect.provideService(RedactionService, redaction),
    ),
  );
  Effect.runSync(redaction.registerValues([canary]));
  // When
  const failure = await Effect.runPromise(Effect.flip(provider.list({})));
  // Then
  if (!(failure instanceof ProviderUnavailableError || failure instanceof ProviderInternalError)) {
    throw new Error("Expected a provider API failure");
  }
  expect(failure._tag).toBe(tag);
  expect(failure.message).not.toContain(canary);
  expect(failure.details).toEqual({ status, body: body.replace(canary, "[redacted]") });
  expect(failure.providerId).toBe("docker");
  expect(failure.operation).toBe("list");
  if (status === 500) expect(failure.message).toContain("engine said [redacted]");
});
