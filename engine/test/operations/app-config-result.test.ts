import { expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { Schema } from "effect";
import { type AppConfigResult, AppConfigResultSchema } from "../../src/operations/app-config-result.ts";

test("encodes full resolved config in baseline key order when metadata is present", () => {
  // Given a strict decoded Landofile and metadata inserted in a different order.
  const authored = { name: "output-order" };
  const input = {
    hostEvents: [{ event: "pre-start", index: 0, step: { cmd: "true" }, status: "active" }],
    sources: [{ id: "local-fragment", sha256: "a".repeat(64) }],
    landofile: Schema.decodeUnknownSync(LandofileShape, { onExcessProperty: "error" })(authored),
    source: "resolved",
    app: authored.name,
  } satisfies AppConfigResult;

  // When the full result crosses the actual machine-output schema encoder.
  const encoded = Schema.encodeSync(AppConfigResultSchema)(input);

  // Then bytes retain the baseline field sequence and all input values.
  expect(JSON.stringify(encoded)).toBe(
    JSON.stringify({
      app: input.app,
      source: input.source,
      landofile: authored,
      sources: input.sources,
      hostEvents: input.hostEvents,
    }),
  );
});

test("omits absent optional metadata while retaining full resolved config key order", () => {
  // Given a strict decoded Landofile without sources or host events metadata.
  const authored = { name: "output-order-minimal" };
  const input = {
    landofile: Schema.decodeUnknownSync(LandofileShape, { onExcessProperty: "error" })(authored),
    source: "resolved",
    app: authored.name,
  } satisfies AppConfigResult;

  // When the full result crosses the actual machine-output schema encoder.
  const encoded = Schema.encodeSync(AppConfigResultSchema)(input);

  // Then only the present fields are emitted, in baseline order.
  expect(JSON.stringify(encoded)).toBe(
    JSON.stringify({ app: input.app, source: input.source, landofile: authored }),
  );
});
