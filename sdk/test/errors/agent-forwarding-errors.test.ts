import { expect, test } from "bun:test";
import { Either, Schema } from "effect";

import * as errors from "@lando/sdk/errors";

test("SshAgentUnavailableError and GpgAgentUnavailableError encode tag, reason and remediation", () => {
  // Given
  const fields = {
    message: "Agent unavailable",
    reason: "socket-missing",
    remediation: "Start the agent.",
  } as const;
  // When
  const ssh = Schema.encodeSync(errors.SshAgentUnavailableError)(
    new errors.SshAgentUnavailableError({ ...fields, mode: "host", socketPath: "/tmp/agent.sock" }),
  );
  const gpg = Schema.encodeSync(errors.GpgAgentUnavailableError)(new errors.GpgAgentUnavailableError(fields));
  // Then
  expect(ssh).toEqual({
    ...fields,
    _tag: "SshAgentUnavailableError",
    mode: "host",
    socketPath: "/tmp/agent.sock",
  });
  expect(gpg).toEqual({ ...fields, _tag: "GpgAgentUnavailableError" });
});

test("transport errors preserve stage and optional cause", () => {
  // Given
  const fields = {
    message: "Relay failed",
    stage: "bridge",
    remediation: "Restart the runtime.",
    cause: { code: "ECONNRESET" },
  } as const;
  // When
  const ssh = Schema.encodeSync(errors.SshAgentTransportError)(new errors.SshAgentTransportError(fields));
  const gpg = Schema.encodeSync(errors.GpgAgentTransportError)(new errors.GpgAgentTransportError(fields));
  // Then
  expect(ssh).toEqual({ ...fields, _tag: "SshAgentTransportError" });
  expect(gpg).toEqual({ ...fields, _tag: "GpgAgentTransportError" });
});

test("agent errors reject unsupported reasons and transport stages", () => {
  // Given
  const fields = { message: "Unavailable", remediation: "Retry." };
  // When
  const results = [
    Schema.decodeUnknownEither(errors.SshAgentUnavailableError)({
      ...fields,
      _tag: "SshAgentUnavailableError",
      mode: "host",
      reason: "gpg-missing",
    }),
    Schema.decodeUnknownEither(errors.GpgAgentUnavailableError)({
      ...fields,
      _tag: "GpgAgentUnavailableError",
      reason: "sidecar-not-running",
    }),
    Schema.decodeUnknownEither(errors.SshAgentTransportError)({
      ...fields,
      _tag: "SshAgentTransportError",
      stage: "discovery",
    }),
    Schema.decodeUnknownEither(errors.GpgAgentTransportError)({
      ...fields,
      _tag: "GpgAgentTransportError",
      stage: "discovery",
    }),
  ];
  // Then
  expect(results.every(Either.isLeft<unknown, unknown>)).toBe(true);
});

test.each(["locked", "unauthenticated", "denied", "timeout", "cli-missing"] as const)(
  "secret store unavailability encodes %s",
  (reason) => {
    // Given
    const fields = { message: "Unavailable", storeId: "1password", reason, remediation: "Unlock the store." };
    // When
    const encoded = Schema.encodeSync(errors.SecretStoreUnavailableError)(
      new errors.SecretStoreUnavailableError(fields),
    );
    // Then
    expect(encoded).toEqual({ ...fields, _tag: "SecretStoreUnavailableError" });
  },
);

test("invalid secret references preserve reference and remediation", () => {
  // Given
  const fields = {
    message: "Invalid reference",
    reference: "op://Vault//field",
    remediation: "Supply an item.",
  };
  // When
  const encoded = Schema.encodeSync(errors.SecretReferenceInvalidError)(
    new errors.SecretReferenceInvalidError(fields),
  );
  // Then
  expect(encoded).toEqual({ ...fields, _tag: "SecretReferenceInvalidError" });
});
