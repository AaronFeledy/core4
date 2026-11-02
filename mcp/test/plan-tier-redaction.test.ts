import { expect, test } from "bun:test";
import { planRedactionValues } from "@lando/redaction/plan-values";
import { makeRedactionService } from "@lando/redaction/service";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { AppPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { dispatchTool } from "../src/dispatch.ts";

const meta = { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 } as const;

const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "proof",
  name: "proof",
  slug: "proof",
  root: "/tmp/proof",
  provider: "test",
  services: {
    db: {
      name: "db",
      type: "test",
      provider: "test",
      primary: true,
      environment: { DB_PASSWORD: "wordpress", API_TOKEN: "substring-private" },
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: meta,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata: meta,
  extensions: {},
  committedLiteralDigests: [sha256Hex("wordpress")],
});

test("MCP exec-result rendering masks bare whole-token password, keeps wordpress-seo, and still substring-masks without result tokens", async () => {
  const values = planRedactionValues(plan);
  expect(values.wholeToken).toEqual(["wordpress"]);
  expect(values.substring).toEqual(["substring-private"]);

  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(values.substring));
  await Effect.runPromise(service.registerValues(values.wholeToken, { match: "whole-token" }));
  const sourceEnv = {};
  const redactor = await Effect.runPromise(service.forProfile("secrets", { sourceEnv }));
  const payload = "PASSWORD=wordpress\nwp-content/plugins/wordpress-seo\nprefix-substring-private-suffix";
  const entry = {
    spec: {
      id: "app:exec",
      summary: "Echo plan-sensitive output",
      resultSchema: Schema.Struct({ stdout: Schema.String }),
      run: () => Effect.succeed({ stdout: payload }),
      // Intentionally omit redactionTokens: registry tiers alone must protect both modes.
    },
  };
  const frames: unknown[] = [];
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: (tokens) => service.forProfile("secrets", { sourceEnv, authoritativeTokens: tokens }),
        execute: () =>
          Effect.succeed(
            resolveCommandCompletion(entry.spec.id, { stdout: payload }, () => ({
              ok: true,
              exitCode: 0,
            })),
          ),
        notify: (frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
      },
    ),
  );

  expect(result.envelope).toMatchObject({
    result: {
      stdout: "PASSWORD=[redacted]\nwp-content/plugins/wordpress-seo\nprefix-[redacted]-suffix",
    },
  });
  expect(result.ok).toBe(true);
  const envelope = JSON.stringify(result.envelope);
  expect(envelope).toContain("wordpress-seo");
  expect(envelope).not.toContain("PASSWORD=wordpress");
  expect(envelope).not.toContain("substring-private");
  expect(JSON.stringify(frames)).not.toContain("PASSWORD=wordpress");
  // Session redactor (no result tokens) still applies the registry tiers.
  expect(redactor.redactString("PASSWORD=wordpress")).toBe("PASSWORD=[redacted]");
  expect(redactor.redactString("wp-content/plugins/wordpress-seo")).toBe("wp-content/plugins/wordpress-seo");
  expect(redactor.redactString("prefix-substring-private-suffix")).toBe("prefix-[redacted]-suffix");
});
