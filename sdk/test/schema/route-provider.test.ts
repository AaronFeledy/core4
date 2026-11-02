import { expect, test } from "bun:test";
import { RouteProviderMismatchError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { Schema } from "effect";

test("preserves route provider mismatch context through the public error codec", () => {
  // Given
  const error = new RouteProviderMismatchError({
    message: "App and router providers differ.",
    providerId: ProviderId.make("docker"),
    hostProviderId: ProviderId.make("lando"),
    remediation: "Run lando setup --provider=docker.",
  });
  // When
  const decoded = Schema.decodeUnknownSync(RouteProviderMismatchError)(
    Schema.encodeSync(RouteProviderMismatchError)(error),
  );
  // Then
  expect(decoded).toMatchObject({
    _tag: "RouteProviderMismatchError",
    providerId: ProviderId.make("docker"),
    hostProviderId: ProviderId.make("lando"),
    remediation: error.remediation,
  });
});
