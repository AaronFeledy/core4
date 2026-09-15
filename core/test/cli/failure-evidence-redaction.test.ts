import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test("debug cause evidence redacts authoritative secrets and private paths before rendering", async () => {
  // Given a gated nested failure containing an opaque SecretStore value and host-private paths.
  const io = createBufferedRendererIO();
  const secret = "0;1";
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  const previousSecret = process.env.LANDO_SECRET_PR989_CAUSE;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";
  process.env.LANDO_SECRET_PR989_CAUSE = secret;

  try {
    // When the real renderer boundary retains private cause evidence.
    await runWithRendererHandling(
      Effect.fail({
        _tag: "OuterDiagnosticFailure",
        message: `setup failed with ${secret} at /home/private/app/.lando.yml`,
        remediation: "Inspect C:\\Users\\private\\lando\\service.log",
        details: {
          status: 503,
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
    process.env.LANDO_SECRET_PR989_CAUSE = previousSecret;
  }

  // Then useful tagged/status evidence remains while every sensitive value is absent.
  const diagnostic = io.stderr();
  expect(diagnostic).toContain("failure-cause-evidence");
  expect(diagnostic).toContain("OuterDiagnosticFailure");
  expect(diagnostic).toContain('"status":503');
  expect(diagnostic).toContain("[redacted]");
  expect(diagnostic).toContain("[path]");
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic).not.toContain("/home/private");
  expect(diagnostic).not.toContain("C:\\Users\\private");
  expect(diagnostic).not.toContain("\\\\private-host\\lando$");
  expect(diagnostic).not.toContain("/var/private");
});
