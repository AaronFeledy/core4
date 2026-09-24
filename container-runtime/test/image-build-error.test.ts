import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { encodeCommandResult } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { requestContainerBuild } from "../src/image-build-http.ts";

test.each(["error", "errorDetail"] as const)("projects a redacted daemon %s frame", async (field) => {
  // Given
  const daemonMessage = 'building at STEP "RUN mkdir -p /etc/lando": password=hunter2 exit status 1';
  const frame = field === "error" ? { error: daemonMessage } : { errorDetail: { message: daemonMessage } };
  const request = () => Effect.succeed({ status: 200, body: JSON.stringify(frame) });

  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      requestContainerBuild({
        request,
        options: { providerId: "docker", api: { request } },
        path: "/build",
        tag: "lando-web",
        stdin: (async function* () {})(),
        secretValues: [],
      }),
    ),
  );
  const output = await Effect.runPromise(
    encodeCommandResult({
      command: "app:start",
      resultSchema: Schema.Void,
      outcome: { _tag: "failure", error: failure },
      redactor: createRedactor("secrets"),
    }),
  );

  // Then
  expect(output).toContain("mkdir -p /etc/lando");
  expect(output).toContain("exit status 1");
  expect(output).toContain("ArtifactBuildError");
  expect(output).toContain("[redacted]");
  expect(output).not.toContain("hunter2");
  expect(failure.message).not.toContain("hunter2");
  expect(failure.remediation).toContain("lando-web");
});

test("redacts before bounding a long daemon diagnostic", async () => {
  // Given: the exact secret straddles the diagnostic limit.
  const secret = "sensitive-build-argument";
  const request = () =>
    Effect.succeed({
      status: 200,
      body: JSON.stringify({ error: `${"x".repeat(4080)}${secret}${"y".repeat(5000)}` }),
    });

  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      requestContainerBuild({
        request,
        options: { providerId: "podman", api: { request } },
        path: "/build",
        tag: "lando-web",
        stdin: (async function* () {})(),
        secretValues: [secret],
      }),
    ),
  );

  // Then
  expect(failure.message).toContain("[redacted]");
  expect(failure.message).not.toContain("sensitive-build");
  expect(failure.message.length).toBeLessThanOrEqual(4200);
  expect(failure.message).toEndWith("…");
});

test.each([
  ["shared", "shared-private-suffix"],
  ["shared", "shared/private-suffix"],
  ["%", "shared/private-suffix"],
])("masks complete overlapping build arguments beginning with %s", async (short, secret) => {
  // Given
  const request = () =>
    Effect.succeed({
      status: 200,
      body: JSON.stringify({ error: `RUN echo ${secret} ${encodeURIComponent(secret)}: exit status 1` }),
    });

  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      requestContainerBuild({
        request,
        options: { providerId: "docker", api: { request } },
        path: "/build",
        tag: "lando-web",
        stdin: (async function* () {})(),
        secretValues: [short, secret],
      }),
    ),
  );

  // Then
  expect(failure.message).toContain("exit status 1");
  expect(failure.message).toContain("[redacted]");
  expect(JSON.stringify(failure)).not.toContain("private-suffix");
});

test("preserves unavailable classification when the build socket is down", async () => {
  // Given
  const request = () =>
    Effect.fail(
      new ProviderUnavailableError({
        providerId: "podman",
        operation: "buildArtifact",
        message: "Connection refused",
      }),
    );

  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      requestContainerBuild({
        request,
        options: { providerId: "podman", api: { request } },
        path: "/build",
        tag: "lando-web",
        stdin: (async function* () {})(),
        secretValues: [],
      }),
    ),
  );

  // Then
  expect(failure._tag).toBe("ProviderUnavailableError");
  expect(failure.message).toBe("Connection refused");
});
