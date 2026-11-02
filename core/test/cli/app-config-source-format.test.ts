import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { type AppConfigResult, renderAppConfigResult } from "@lando/core/cli/operations";
import { LandofileShape, type LandofileSourceValue } from "@lando/sdk/schema";
import { yamlRoundTripRecord } from "@lando/sdk/test";

import { appConfigOptionsFromInput } from "../../src/cli/command-specs/app/config/index.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";

const landofile = Schema.decodeUnknownSync(LandofileShape)({
  name: "test-app-config",
  recipe: "node",
  services: { web: { api: 4, type: "node" } },
});

const resolvedResult: AppConfigResult = {
  app: "test-app-config",
  source: "resolved",
  landofile,
};

const renderWithFormat = (result: AppConfigResult, format: "json" | "table" | "yaml"): string =>
  Schema.decodeUnknownSync(Schema.String)(Reflect.apply(renderAppConfigResult, undefined, [result, format]));

describe("app config yaml", () => {
  test("renderAppConfigResult emits landofile-only YAML when format is yaml", () => {
    const yaml = renderWithFormat(resolvedResult, "yaml");

    expect(yaml).toContain("name: test-app-config");
    expect(yaml).toContain("recipe: node");
    expect(yaml).toContain("services:");
    expect(yaml).not.toMatch(/^app:/m);
    expect(yaml).not.toContain("source: resolved");
  });

  test("renderAppConfigResult table output is unchanged", () => {
    const table = renderAppConfigResult(resolvedResult, "table");

    expect(table).toBe("app\ttest-app-config\nservices\tweb\nrecipe\tnode");
  });

  test("renderAppConfigResult table output uses object-form recipe id", () => {
    const provenanceLandofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "test-app-config",
      recipe: {
        id: "lamp",
        version: "1.0.0",
        producer: {
          sourceKind: "bundled",
          packageName: "@lando/core",
          recipeId: "lamp",
          manifestVersion: "1.0.0",
          contentDigest: `sha256:${"a".repeat(64)}`,
        },
        options: { php: "8.3" },
      },
      services: { web: { api: 4, type: "php:8.3" } },
    });
    const table = renderAppConfigResult(
      { app: "test-app-config", source: "resolved", landofile: provenanceLandofile },
      "table",
    );

    expect(table).toBe("app\ttest-app-config\nservices\tweb\nrecipe\tlamp");
  });

  test("renderAppConfigResult get output ignores yaml", () => {
    const result: AppConfigResult = { source: "resolved", subcommand: "get", key: "recipe", value: "node" };

    expect(renderWithFormat(result, "yaml")).toBe("node");
  });

  test("renderAppConfigResult shows an empty service list for a full resolved view", () => {
    expect(renderWithFormat({ source: "resolved", app: "x", landofile: {} }, "table")).toBe(
      "app\tx\nservices\t(none)",
    );
  });

  describe("merged table", () => {
    test("reports the authored app, services, and recipe when a typed field holds an unresolved expression", () => {
      // Given: an authored composition that effective validation would reject (primary is not a boolean yet)
      const result: AppConfigResult = {
        source: "merged",
        landofile: {
          name: "distinct-app",
          recipe: "node",
          services: { web: { type: "node", primary: "{{ app.name == 'distinct-app' }}" } },
        },
      };
      // When
      const table = renderAppConfigResult(result, "table");
      // Then
      expect(table).toBe("app\tdistinct-app\nservices\tweb\nrecipe\tnode");
    });

    test("uses the authored object-form recipe id", () => {
      // Given
      const result: AppConfigResult = {
        source: "merged",
        landofile: { name: "distinct-app", recipe: { id: "lamp", options: { php: "8.3" } }, services: {} },
      };
      // When
      const table = renderAppConfigResult(result, "table");
      // Then
      expect(table).toBe("app\tdistinct-app\nservices\t(none)\nrecipe\tlamp");
    });

    test.each<{ readonly label: string; readonly landofile: LandofileSourceValue }>([
      { label: "a scalar", landofile: "not a mapping" },
      { label: "null", landofile: null },
      { label: "a list", landofile: ["web"] },
      { label: "mistyped metadata", landofile: { name: ["x"], services: "oops", recipe: 42 } },
      { label: "a recipe without a string id", landofile: { services: null, recipe: { id: 7 } } },
    ])("renders $label source data without metadata instead of crashing", ({ landofile }) => {
      // Given
      const result: AppConfigResult = { source: "merged", landofile };
      // When
      const table = renderAppConfigResult(result, "table");
      // Then
      expect(table).toBe("app\t\nservices\t(none)");
    });
  });

  test("appConfigOptionsFromInput preserves yaml format", () => {
    expect(appConfigOptionsFromInput({ flags: { format: "yaml" } }).format).toBe("yaml");
  });

  describe("native input mapping", () => {
    test("compiled input maps view --format yaml", () => {
      const options = appConfigOptionsFromInput(
        compiledCommandInputFromArgv("app:config", ["view", "--format", "yaml"]),
      );

      expect(options).toEqual({ subcommand: "view", format: "yaml" });
    });
  });

  test("app config yaml output round-trips danger-corpus values through Bun.YAML.parse", () => {
    // Given: a landofile whose environment map carries the danger corpus plus 8080:80
    const environment = { ...yamlRoundTripRecord(), port: "8080:80" };
    const source = {
      name: "test-app-config",
      recipe: "node",
      services: { web: { api: 4, type: "node", environment } },
    };
    const landofile = Schema.decodeUnknownSync(LandofileShape)(source);

    // When
    const rendered = renderWithFormat({ app: "test-app-config", source: "resolved", landofile }, "yaml");

    // Then
    expect(Bun.YAML.parse(rendered)).toEqual(Schema.encodeSync(LandofileShape)(landofile));
    expect(rendered).toContain("port: 8080:80");
    expect(rendered).not.toContain('"8080:80"');
    expect(rendered).toContain('"True"');
    expect(rendered).toContain('"~"');
  });
});
