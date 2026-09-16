import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ContainerTransportError } from "@lando/container-runtime/transport";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test("debug cause evidence omits unknown values from every nominal structural field", async () => {
  // Given every nominal structural field contains a custom non-environment secret.
  const io = createBufferedRendererIO();
  const secret = "custom-nonenv-secret-989";
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";

  try {
    // When the real renderer boundary retains private cause evidence.
    await runWithRendererHandling(
      Effect.fail({
        _tag: secret,
        name: secret,
        providerId: secret,
        operation: secret,
        kind: secret,
        message: `setup failed with ${secret} at /home/private/app/.lando.yml`,
        remediation: "Inspect C:\\Users\\private\\lando\\service.log",
        details: {
          status: secret,
          method: secret,
          failureKind: secret,
          body: "runtime at \\\\private-host\\lando$\\runtime\\service.log failed",
          path: "/var/private/lando/podman.sock",
        },
      }),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        io,
        formatError: () => "setup failed",
        setExitCode: () => undefined,
      },
    );
  } finally {
    process.env.LANDO_DEBUG_CAUSE_CHAIN = previousGate;
  }

  // Then the diagnostic marker remains while every unrecognized value is absent.
  const diagnostic = io.stderr();
  expect(diagnostic).toContain("failure-cause-evidence");
  expect(diagnostic).not.toContain("setup failed with");
  expect(diagnostic).not.toContain("Inspect");
  expect(diagnostic).not.toContain("runtime at");
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic).not.toContain("/home/private");
  expect(diagnostic).not.toContain("C:\\Users\\private");
  expect(diagnostic).not.toContain("\\\\private-host\\lando$");
  expect(diagnostic).not.toContain("/var/private");
});

test("debug cause evidence classifies a closed registry authentication diagnostic", async () => {
  // Given a pull failure with a typed HTTP transport cause.
  const io = createBufferedRendererIO();
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";
  const transport = new ContainerTransportError({
    kind: "http",
    operation: "podman-api",
    message: "request failed",
    details: { method: "POST", status: 401 },
  });
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "pullArtifact",
    message: "pull failed",
    details: { failureKind: "registry-auth", details: { status: 401 } },
    cause: transport,
  });

  try {
    // When the renderer emits private failure evidence.
    await runWithRendererHandling(Effect.fail(failure), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      formatError: () => "pull failed",
      setExitCode: () => undefined,
    });
  } finally {
    process.env.LANDO_DEBUG_CAUSE_CHAIN = previousGate;
  }

  // Then only the closed diagnosis survives.
  expect(io.stderr()).toContain(
    '"imagePull":{"domain":"image-pull","failureKind":"registry-auth","httpStatus":401,"transportKind":"http"}',
  );
});

test("debug cause evidence classifies a closed pull transport connection diagnostic", async () => {
  // Given a generic pull failure with a typed connection cause.
  const io = createBufferedRendererIO();
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";
  const transport = new ContainerTransportError({
    kind: "connect",
    operation: "podman-api",
    message: "connection failed",
  });
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "pullArtifact",
    message: "pull failed",
    details: { failureKind: "generic" },
    cause: transport,
  });

  try {
    // When the renderer emits private failure evidence.
    await runWithRendererHandling(Effect.fail(failure), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      formatError: () => "pull failed",
      setExitCode: () => undefined,
    });
  } finally {
    process.env.LANDO_DEBUG_CAUSE_CHAIN = previousGate;
  }

  // Then the diagnosis identifies the transport without retaining its message.
  expect(io.stderr()).toContain(
    '"imagePull":{"domain":"image-pull","failureKind":"generic","transportKind":"connect"}',
  );
  expect(io.stderr()).not.toContain("connection failed");
});

test("debug cause evidence retains a closed pull stream-frame signature", async () => {
  // Given a pull error frame contains private free-form context plus a closed classification.
  const io = createBufferedRendererIO();
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  const secret = "private-registry.example/team/private-image:latest";
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "pullArtifact",
    message: `manifest unknown for ${secret}`,
    details: {
      failureKind: "generic",
      source: "stream-frame",
      signature: "manifest-unknown",
      reference: secret,
      error: `manifest unknown for ${secret}`,
    },
  });

  try {
    // When the renderer emits private failure evidence.
    await runWithRendererHandling(Effect.fail(failure), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      formatError: () => "pull failed",
      setExitCode: () => undefined,
    });
  } finally {
    process.env.LANDO_DEBUG_CAUSE_CHAIN = previousGate;
  }

  // Then only the closed frame origin and signature survive.
  expect(io.stderr()).toContain(
    '"imagePull":{"domain":"image-pull","failureKind":"generic","source":"stream-frame","signature":"manifest-unknown"}',
  );
  expect(io.stderr()).not.toContain(secret);
  expect(io.stderr()).not.toContain("manifest unknown for");
});

test("debug cause evidence retains an allowlisted transport read code", async () => {
  // Given a pull failure wraps a typed response-read error and an untrusted raw code.
  const io = createBufferedRendererIO();
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";
  const transport = new ContainerTransportError({
    kind: "read",
    operation: "podman-api",
    message: "read failed at /private/socket",
    systemCode: "ECONNRESET",
    cause: { code: "PRIVATE_CODE", path: "/private/socket" },
  });
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "pullArtifact",
    message: "pull failed",
    details: { failureKind: "generic" },
    cause: transport,
  });

  try {
    // When the renderer emits private failure evidence.
    await runWithRendererHandling(Effect.fail(failure), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      formatError: () => "pull failed",
      setExitCode: () => undefined,
    });
  } finally {
    process.env.LANDO_DEBUG_CAUSE_CHAIN = previousGate;
  }

  // Then only the closed transport kind and allowlisted system code survive.
  expect(io.stderr()).toContain(
    '"imagePull":{"domain":"image-pull","failureKind":"generic","transportKind":"read","systemCode":"ECONNRESET"}',
  );
  expect(io.stderr()).not.toContain("PRIVATE_CODE");
  expect(io.stderr()).not.toContain("/private/socket");
});

test("debug cause evidence omits out-of-range HTTP status numbers", async () => {
  const io = createBufferedRendererIO();
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";
  try {
    await runWithRendererHandling(
      Effect.fail({
        _tag: "ProviderUnavailableError",
        operation: "pullArtifact",
        details: { failureKind: "generic", status: 99 },
        cause: { _tag: "ContainerTransportError", kind: "http", details: { status: 600 } },
      }),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        io,
        formatError: () => "pull failed",
        setExitCode: () => undefined,
      },
    );
  } finally {
    process.env.LANDO_DEBUG_CAUSE_CHAIN = previousGate;
  }

  expect(io.stderr()).not.toContain('"status":99');
  expect(io.stderr()).not.toContain('"status":600');
  expect(io.stderr()).not.toContain('"httpStatus"');
});
