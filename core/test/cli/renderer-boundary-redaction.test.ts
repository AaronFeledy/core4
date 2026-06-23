import { Effect, Layer } from "effect";

import { createRedactor } from "@lando/sdk/secrets";
import { SetupNetworkTrustError } from "../../src/cli/commands/setup-network-trust.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { RedactionService } from "../../src/redaction/service.ts";

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
});
