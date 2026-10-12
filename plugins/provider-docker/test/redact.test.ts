import { afterEach, beforeEach, expect, test } from "bun:test";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { Effect } from "effect";

import { type DockerApiClient, makeRuntimeProvider } from "@lando/provider-docker";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

beforeEach(resetRegisteredRedactionValuesForTesting);
afterEach(resetRegisteredRedactionValuesForTesting);

test.each([
  [500, "ProviderUnavailableError"],
  [200, "ProviderInternalError"],
] as const)("redacts runtime-registered values in list failures with HTTP %s", async (status, tag) => {
  // Given
  const canary = "opaque-docker-canary-1261";
  const body =
    status === 500 ? JSON.stringify({ message: `engine said ${canary}` }) : `invalid JSON ${canary}`;
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: () => Effect.succeed({ status, body }),
  };
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  Effect.runSync(registerRedactionValues([canary]));
  // When
  const failure = await Effect.runPromise(Effect.flip(provider.list({})));
  // Then
  if (!(failure instanceof ProviderUnavailableError || failure instanceof ProviderInternalError)) {
    throw new Error("Expected a provider API failure");
  }
  expect(failure._tag).toBe(tag);
  expect(failure.message).not.toContain(canary);
  expect(JSON.stringify(failure.details)).not.toContain(canary);
  expect(JSON.stringify(failure.details)).toContain("[redacted]");
  expect(failure.details).toEqual({ status, body: body.replace(canary, "[redacted]") });
  expect(failure.providerId).toBe("docker");
  expect(failure.operation).toBe("list");
  if (status === 500) expect(failure.message).toContain("engine said [redacted]");
});
