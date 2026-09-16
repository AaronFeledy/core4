import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test("debug cause evidence omits free-form fields without authoritative application secrets", async () => {
  // Given a gated nested failure containing a custom non-environment secret and host-private paths.
  const io = createBufferedRendererIO();
  const secret = "custom-nonenv-secret-989";
  const previousGate = process.env.LANDO_DEBUG_CAUSE_CHAIN;
  process.env.LANDO_DEBUG_CAUSE_CHAIN = "1";

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
  }

  // Then allowlisted tagged/status evidence remains while every free-form value is absent.
  const diagnostic = io.stderr();
  expect(diagnostic).toContain("failure-cause-evidence");
  expect(diagnostic).toContain("OuterDiagnosticFailure");
  expect(diagnostic).toContain('"status":503');
  expect(diagnostic).not.toContain("setup failed with");
  expect(diagnostic).not.toContain("Inspect");
  expect(diagnostic).not.toContain("runtime at");
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic).not.toContain("/home/private");
  expect(diagnostic).not.toContain("C:\\Users\\private");
  expect(diagnostic).not.toContain("\\\\private-host\\lando$");
  expect(diagnostic).not.toContain("/var/private");
});
