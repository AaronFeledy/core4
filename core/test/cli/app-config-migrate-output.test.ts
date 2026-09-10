import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import type { RecipeProducer } from "@lando/sdk/schema";
import {
  type AppConfigMigrateResult,
  AppConfigMigrateResultSchema,
  renderAppConfigMigrateResult,
} from "../../src/cli/commands/app-config-migrate-output.ts";

const DIGEST = `sha256:${"ab".repeat(32)}`;

const producer = (version: string, recipeId = "lamp"): RecipeProducer => ({
  sourceKind: "bundled",
  packageName: `@lando/recipe-${recipeId}`,
  recipeId,
  manifestVersion: version,
  contentDigest: DIGEST,
});

const base = (
  overrides: Partial<AppConfigMigrateResult> & Pick<AppConfigMigrateResult, "status" | "mode">,
): AppConfigMigrateResult => ({
  landofilePath: "/app/.lando.yml",
  target: producer("2.0.0"),
  edges: [],
  next: "",
  ...overrides,
});

describe("AppConfigMigrateResultSchema", () => {
  it("round-trips encode and decode", () => {
    const result = base({
      mode: "write",
      status: "partial",
      recorded: producer("1.0.0"),
      committed: producer("1.1.0"),
      edges: [
        {
          from: "1.0.0",
          to: "1.1.0",
          status: "satisfied",
          hunks: [
            {
              id: "hunk-aaaaaaaaaaaaaaaaaaaaaaaa",
              kind: "add",
              layer: "canonical",
              path: "services.appserver.ssl",
              mappedPath: "services.appserver.ssl",
              classification: "selected",
            },
          ],
        },
        {
          from: "1.1.0",
          to: "2.0.0",
          status: "blocked",
          hunks: [
            {
              id: "hunk-bbbbbbbbbbbbbbbbbbbbbbbb",
              kind: "replace",
              layer: "canonical",
              path: "services.appserver.type",
              mappedPath: "services.web.type",
              classification: "blocking",
              reason: "site-taken-over",
              remediation: "Restore the generated expression or skip this edge.",
            },
          ],
        },
      ],
      next: "run `lando rebuild`",
    });

    const encoded = Schema.encodeSync(AppConfigMigrateResultSchema)(result);
    const decoded = Schema.decodeUnknownSync(AppConfigMigrateResultSchema)(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(decoded.status).toBe("partial");
    expect(decoded.edges).toHaveLength(2);
    expect<unknown>(decoded.edges[1]?.hunks[0]?.reason).toBe("site-taken-over");
  });
});

describe("renderAppConfigMigrateResult", () => {
  it("renders a committed write with rebuild instruction", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "write",
        status: "committed",
        committed: producer("2.0.0"),
        edges: [
          {
            from: "1.0.0",
            to: "2.0.0",
            status: "satisfied",
            hunks: [
              {
                id: "hunk-cccccccccccccccccccccccc",
                kind: "option-default",
                layer: "canonical",
                path: "recipe.options.php",
                mappedPath: "recipe.options.php",
                classification: "already-satisfied",
              },
              {
                id: "hunk-dddddddddddddddddddddddd",
                kind: "add",
                layer: "canonical",
                path: "services.appserver.ssl",
                mappedPath: "services.appserver.ssl",
                classification: "selected",
              },
            ],
          },
        ],
        next: "run `lando rebuild`",
      }),
    );

    expect(text).toContain("Landofile: /app/.lando.yml");
    expect(text).toContain("Target: lamp 2.0.0");
    expect(text).toContain("Producer: bundled @lando/recipe-lamp");
    expect(text).toContain("Status: committed");
    expect(text).toContain("1.0.0 -> 2.0.0: option-default recipe.options.php [already-satisfied]");
    expect(text).toContain("1.0.0 -> 2.0.0: add services.appserver.ssl [selected]");
    expect(text.endsWith("run `lando rebuild`")).toBe(true);
    expect(text).not.toContain("Dry-run");
  });

  it("renders a partial result with every hunk and rebuild", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "write",
        status: "partial",
        recorded: producer("1.0.0"),
        committed: producer("1.1.0"),
        edges: [
          {
            from: "1.0.0",
            to: "1.1.0",
            status: "satisfied",
            hunks: [
              {
                id: "hunk-eeeeeeeeeeeeeeeeeeeeeeee",
                kind: "rename",
                layer: "canonical",
                path: "services.appserver",
                mappedPath: "services.web",
                classification: "selected",
              },
            ],
          },
          {
            from: "1.1.0",
            to: "2.0.0",
            status: "blocked",
            hunks: [
              {
                id: "hunk-ffffffffffffffffffffffff",
                kind: "replace",
                layer: "canonical",
                path: "services.appserver.type",
                mappedPath: "services.web.type",
                classification: "blocking",
                reason: "value-conflict",
                remediation: "Align the site value with the generated snapshot.",
              },
            ],
          },
        ],
        next: "run `lando rebuild`",
      }),
    );

    expect(text).toContain("Status: partial");
    expect(text).toContain("Recorded: lamp 1.0.0");
    expect(text).toContain("Committed: lamp 1.1.0");
    expect(text).toContain("Edge: 1.0.0 -> 1.1.0 (satisfied)");
    expect(text).toContain("1.0.0 -> 1.1.0: rename services.appserver [selected]");
    expect(text).toContain("Edge: 1.1.0 -> 2.0.0 (blocked)");
    expect(text).toContain("1.1.0 -> 2.0.0: replace services.appserver.type [blocking] (value-conflict)");
    expect(text).toContain("Align the site value with the generated snapshot.");
    expect(text.endsWith("run `lando rebuild`")).toBe(true);
  });

  it("renders a blocked input with reason and remediation", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "write",
        status: "blocked",
        blocked: {
          reason: "bare-provenance",
          detail: "Recipe provenance is a bare id string.",
          remediation: "Re-init or upgrade provenance to an object with a producer.",
        },
        next: "Fix provenance, then re-run migrate.",
      }),
    );

    expect(text).toContain("Status: blocked");
    expect(text).toContain("Blocked (bare-provenance): Recipe provenance is a bare id string.");
    expect(text).toContain("Re-init or upgrade provenance to an object with a producer.");
    expect(text).toContain("Fix provenance, then re-run migrate.");
    expect(text).not.toContain("run `lando rebuild`");
  });

  it("renders no-op already-current without rebuild", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "write",
        status: "no-op",
        noMutation: "already-current",
        next: "",
      }),
    );

    expect(text).toContain("Status: no-op");
    expect(text).toContain("Nothing changed: already current.");
    expect(text).not.toContain("run `lando rebuild`");
  });

  it("renders no-op missing-old-snapshot", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "write",
        status: "no-op",
        noMutation: "missing-old-snapshot",
        next: "",
      }),
    );

    expect(text).toContain("Nothing changed: no old snapshot to migrate from.");
  });

  it("renders dry-run with the complete ordered hunk set and no write claim", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "dry-run",
        status: "committed",
        committed: producer("2.0.0"),
        edges: [
          {
            from: "1.0.0",
            to: "2.0.0",
            status: "satisfied",
            hunks: [
              {
                id: "hunk-111111111111111111111111",
                kind: "remove",
                layer: "canonical",
                path: "services.legacy",
                mappedPath: "services.legacy",
                classification: "selected",
              },
              {
                id: "hunk-222222222222222222222222",
                kind: "add",
                layer: "canonical",
                path: "services.cache",
                mappedPath: "services.cache",
                classification: "retained-option",
              },
            ],
          },
        ],
        next: "run `lando rebuild`",
      }),
    );

    expect(text).toContain("Dry-run: nothing was written.");
    expect(text).toContain("1.0.0 -> 2.0.0: remove services.legacy [selected]");
    expect(text).toContain("1.0.0 -> 2.0.0: add services.cache [retained-option]");
    expect(text.endsWith("run `lando rebuild`")).toBe(true);
  });

  it("renders a blocked hunk with reason and remediation", () => {
    const text = renderAppConfigMigrateResult(
      base({
        mode: "write",
        status: "blocked",
        edges: [
          {
            from: "1.0.0",
            to: "2.0.0",
            status: "blocked",
            hunks: [
              {
                id: "hunk-333333333333333333333333",
                kind: "replace",
                layer: "user",
                path: "services.appserver.env.FOO",
                mappedPath: "services.appserver.env.FOO",
                classification: "blocking",
                reason: "layer-not-owned",
                remediation: "Move the edit to a layer the recipe owns.",
              },
            ],
          },
        ],
        next: "",
      }),
    );

    expect(text).toContain("1.0.0 -> 2.0.0: replace services.appserver.env.FOO [blocking] (layer-not-owned)");
    expect(text).toContain("Move the edit to a layer the recipe owns.");
    expect(text).not.toContain("run `lando rebuild`");
  });
});
