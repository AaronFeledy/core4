import { describe, expect, test } from "bun:test";

import { ComposeKeyRejectedError } from "@lando/sdk/errors";

describe("ComposeKeyRejectedError", () => {
  test("carries the rejected Compose key context", () => {
    // Given
    const payload = {
      message: "Compose key is not supported.",
      source: "/workspace/compose.yml",
      service: "appserver",
      keyPath: "services.appserver.deploy",
      remediation: "Remove the deploy key.",
    };

    // When
    const error = new ComposeKeyRejectedError(payload);

    // Then
    expect(error).toMatchObject({ _tag: "ComposeKeyRejectedError", ...payload });
  });

  test("allows rejection context without a service", () => {
    // Given
    const payload = {
      message: "Compose key is not supported.",
      source: "/workspace/compose.yml",
      keyPath: "networks.default.driver",
      remediation: "Remove the driver key.",
    };

    // When
    const error = new ComposeKeyRejectedError(payload);

    // Then
    expect(error.service).toBeUndefined();
  });
});
