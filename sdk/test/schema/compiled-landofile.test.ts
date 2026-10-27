import { expect, test } from "bun:test";
import { parseExpressionEither } from "@lando/sdk/expressions";
import { CompiledLandofile, LoadScopedLandofile } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each(["source", "composed", "load-scoped", "identity-scoped", "service-scoped"] as const)(
  "round-trips %s carrier with parsed sites and original list attribution",
  (stage) => {
    // Given
    const parsed = parseExpressionEither("{{ services.db.creds.password }}", { filePath: "/app/.lando.yml" });
    if (Result.isFailure(parsed)) throw parsed.failure;
    const input = {
      stage,
      document: { services: { db: { type: "postgres" } } },
      context: { appRoot: "/app", env: { CAPTURED: "literal ${secret:X}" } },
      pendingSites: [
        {
          id: "base:17",
          path: ["services", "db", "environment", "PASSWORD"],
          source: { file: "/app/.lando.yml", layer: "base", path: ["services", "db", "environment", 3] },
          template: parsed.success,
        },
      ],
    };
    // When
    const decoded = Schema.decodeUnknownSync(CompiledLandofile)(input);
    const roundtrip = Schema.decodeUnknownSync(CompiledLandofile)(
      JSON.parse(JSON.stringify(Schema.encodeSync(CompiledLandofile)(decoded))),
    );
    // Then
    expect(JSON.parse(JSON.stringify(roundtrip))).toEqual(input);
  },
);

test("rejects bare documents and wrong stages at the planner admission boundary", () => {
  // Given
  const bare = { services: { db: { type: "postgres" } } };
  // When
  const bareResult = Schema.decodeUnknownResult(LoadScopedLandofile)(bare);
  const sourceResult = Schema.decodeUnknownResult(LoadScopedLandofile)({
    stage: "source",
    document: bare,
    pendingSites: [],
    context: { appRoot: "/app", env: {} },
  });
  // Then
  expect(Result.isFailure(bareResult)).toBe(true);
  expect(Result.isFailure(sourceResult)).toBe(true);
});
