import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { SetupNetworkTrustError } from "../../src/cli/commands/setup-network-trust.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret", "proxypass"] })),
});

describe("runWithRendererHandling redaction", () => {
  test("redacts formatted failure diagnostics", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.fail(new Error("boom")), {
      runtime: redactionLayer,
      rendererMode: "plain",
      io,
      formatError: () => "formatted topsecret diagnostic",
      setExitCode: () => undefined,
    });

    expect(io.stderr()).toContain("[redacted]");
    expect(io.stderr()).not.toContain("topsecret");
  });

  test("redacts proxy credentials embedded in SetupNetworkTrustError diagnostics", async () => {
    const io = createBufferedRendererIO();
    const failure = new SetupNetworkTrustError({
      kind: "proxy-authentication",
      message: "Proxy http://user:proxypass@proxy.local:3128 rejected authentication",
      remediation: "Update http://user:proxypass@proxy.local:3128 credentials.",
    });

    await runWithRendererHandling(Effect.fail(failure), {
      runtime: redactionLayer,
      rendererMode: "plain",
      io,
      formatError: (error) => {
        const setupError = error as SetupNetworkTrustError;
        return `${setupError.message} ${setupError.remediation}`;
      },
      setExitCode: () => undefined,
    });

    expect(io.stderr()).toContain("[redacted]");
    expect(io.stderr()).not.toContain("proxypass");
  });

  test("redacts diagnostics when the runtime layer fails before the command runs", async () => {
    const io = createBufferedRendererIO();
    const previous = process.env.BUN_AUTH_TOKEN;
    process.env.BUN_AUTH_TOKEN = "outersecret";
    try {
      const failingRuntime = Layer.effect(
        RedactionService,
        Effect.fail("boot failed with outersecret"),
      ) as unknown as Layer.Layer<never, string>;

      await runWithRendererHandling(Effect.succeed("unreached"), {
        runtime: failingRuntime,
        rendererMode: "plain",
        io,
        formatError: (error) => String(error),
        setExitCode: () => undefined,
      });
    } finally {
      if (previous === undefined) {
        process.env.BUN_AUTH_TOKEN = undefined;
      } else {
        process.env.BUN_AUTH_TOKEN = previous;
      }
    }

    expect(io.stderr()).toContain("[redacted]");
    expect(io.stderr()).not.toContain("outersecret");
  });

  test("redacts exact result tokens from plain command output", async () => {
    const io = createBufferedRendererIO();
    const secret = "bare-tooling-password";

    await runWithRendererHandling(Effect.succeed({ stdout: secret, redactionTokens: [secret] }), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      redactionTokens: (result) => result.redactionTokens,
      render: (result) => result.stdout,
      formatError: String,
      setExitCode: () => undefined,
    });

    expect(io.stdout()).toContain("[redacted]");
    expect(io.stdout()).not.toContain(secret);
  });

  test("redacts exact result tokens from JSON command output", async () => {
    const io = createBufferedRendererIO();
    const secret = "bare-tooling-token";

    await runWithRendererHandling(Effect.succeed({ stdout: secret, redactionTokens: [secret] }), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      resultSchema: Schema.Struct({ stdout: Schema.String }),
      io,
      redactionTokens: (result) => result.redactionTokens,
      render: (result) => result.stdout,
      formatError: String,
      setExitCode: () => undefined,
    });

    expect(io.stdout()).toContain("[redacted]");
    expect(io.stdout()).not.toContain(secret);
  });
});
