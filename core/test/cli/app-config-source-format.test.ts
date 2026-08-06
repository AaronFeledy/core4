import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { type AppConfigResult, renderAppConfigResult } from "@lando/core/cli/operations";
import { LandofileShape } from "@lando/sdk/schema";

import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import { appConfigOptionsFromInput } from "../../src/cli/oclif/commands/app/config/index.ts";

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

  test("renderAppConfigResult get output ignores yaml", () => {
    const result: AppConfigResult = { subcommand: "get", value: "node" };

    expect(renderWithFormat(result, "yaml")).toBe("node");
  });

  test("renderAppConfigResult falls back to table when landofile is absent", () => {
    expect(renderWithFormat({ app: "x" }, "yaml")).toBe("app\tx\nservices\t(none)");
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
});
