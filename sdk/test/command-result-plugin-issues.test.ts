import { expect, test } from "bun:test";
import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { GuideFrontmatterValidationError, PluginManifestError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import publicSurface from "./fixtures/sdk-public-surface.json";

test("matches validation error fields in the public surface", () => {
  expect(Object.keys(PluginManifestError.fields).sort()).toEqual(publicSurface.pluginManifestErrorFields);
  expect(Object.keys(GuideFrontmatterValidationError.fields).sort()).toEqual(
    publicSurface.guideFrontmatterValidationErrorFields,
  );
});

test("preserves plugin manifest issues when encoding a JSON failure envelope", () => {
  // Given
  const issues = [{ path: ["unsupported"], message: "Unexpected key" }];
  const error = new PluginManifestError({
    message: "Invalid plugin manifest.",
    pluginName: "@acme/lando-plugin-broken",
    issues,
    remediation: "Remove unsupported keys from package.json.",
  });

  // When
  const output = Effect.runSync(
    encodeCommandResult({
      command: "meta:plugin:link",
      resultSchema: Schema.Unknown,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );

  // Then
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(output));
  expect(envelope.error).toMatchObject({
    _tag: "PluginManifestError",
    issues,
    remediation: "Remove unsupported keys from package.json.",
  });
});
