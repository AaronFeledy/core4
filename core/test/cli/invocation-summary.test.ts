import { describe, expect, test } from "bun:test";

import { summarizeInvocationArgv, summarizeInvocationRecord } from "../../src/cli/invocation-summary.ts";

describe("lifecycle invocation argv summary", () => {
  test("masks inline and separated secret-like long flag values", () => {
    // Given
    const argv = [
      "start",
      "--service",
      "appserver",
      "--password=hunter2",
      "--passwd=passwd-value",
      "--secret=secret-value",
      "--api_key",
      "key-value",
      "--apikey=apikey-value",
      "--api-key=api-key-value",
      "--registry-token",
      "token-value",
      "--credential=credential-value",
      "--bearer=bearer-value",
      "--authorization=Bearer opaque",
      "--auth-key",
      "auth-value",
    ];

    // When
    const summary = summarizeInvocationArgv(argv);

    // Then
    expect(summary).toEqual([
      "[redacted]",
      "--service",
      "[redacted]",
      "--password=[redacted]",
      "--passwd=[redacted]",
      "--secret=[redacted]",
      "--api_key",
      "[redacted]",
      "--apikey=[redacted]",
      "--api-key=[redacted]",
      "--registry-token",
      "[redacted]",
      "--credential=[redacted]",
      "--bearer=[redacted]",
      "--authorization=[redacted]",
      "--auth-key",
      "[redacted]",
    ]);
  });

  test("does not consume a following flag as a separated secret value", () => {
    // Given
    const argv = ["start", "--token", "--verbose", "--service", "appserver"];

    // When
    const summary = summarizeInvocationArgv(argv);

    // Then
    expect(summary).toEqual(["[redacted]", "--token", "--verbose", "--service", "[redacted]"]);
  });

  test("collapses the opaque passthrough tail into one count-bearing placeholder", () => {
    // Given
    const argv = ["start", "--service", "appserver", "--", "hunter2", "--token", "opaque"];

    // When
    const summary = summarizeInvocationArgv(argv);

    // Then
    expect(summary).toEqual([
      "[redacted]",
      "--service",
      "[redacted]",
      "--",
      "[redacted] (3 passthrough args)",
    ]);
  });

  test("retains record shape without retaining non-boolean values", () => {
    expect(
      summarizeInvocationRecord({
        service: "appserver",
        retries: 3,
        verbose: true,
        services: ["appserver", "database"],
      }),
    ).toEqual({
      service: "[redacted]",
      retries: "[redacted]",
      verbose: true,
      services: "[redacted] (2 values)",
    });
  });
});
