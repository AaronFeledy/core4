import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { sha256Hex } from "@lando/sdk/digest";
import { AppPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { registerPlanRedaction } from "../../src/services/plan-redaction.ts";

test.each([
  [{ DB_PASSWORD: "wordpress" }, "[redacted] wordpress-seo override-tail", []],
  [{ OTHER_PASSWORD: "wordpress" }, "[redacted] wordpress-seo override-tail", []],
  [{ DB_PASSWORD: "override" }, "[redacted] wordpress-seo [redacted]-tail", ["override"]],
] as const)("registers lowered env %j without flattening plan tokens", async (env, expected, substring) => {
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "tier-plan",
    name: "tier-plan",
    slug: "tier-plan",
    root: "/tmp/tier-plan",
    provider: "test",
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
    extensions: {
      "@lando/core/effective-tooling": { tasks: { run: { env: { DB_PASSWORD: "wordpress" } } } },
    },
    committedLiteralDigests: [sha256Hex("wordpress")],
  });
  const redaction = makeRedactionService();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const values = yield* registerPlanRedaction(plan, [env]);
      const redactor = yield* redaction.forProfile("secrets");
      return {
        substring: values.substring,
        text: redactor.redactString("wordpress wordpress-seo override-tail"),
      };
    }).pipe(Effect.provideService(RedactionService, redaction)),
  );
  expect(result).toEqual({ substring: [...substring], text: expected });
});
