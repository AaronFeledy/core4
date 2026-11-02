import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { ConfigLintResult, type ConfigLintViolation } from "@lando/sdk/schema";
import { renderConfigLintResult } from "../../src/cli/commands/app-config-lint.ts";
import { renderConfigLintViolations } from "../../src/cli/commands/config-lint-rendering.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const excessKey = (overrides: Partial<ConfigLintViolation> = {}): ConfigLintViolation => ({
  rule: "landofile.validation",
  severity: "error",
  path: ["services", "web", "imagee"],
  message: "Expected no excess property",
  suggestion: 'Did you mean "image"?',
  line: 3,
  column: 5,
  scopes: ["fragment"],
  source: { file: "/app/.lando.local.yml", layer: "local", path: ["services", "web", "imagee"] },
  ...overrides,
});

test("config lint text visibly escapes terminal controls", () => {
  // Given
  const violation: ConfigLintViolation = {
    rule: "landofile.validation",
    severity: "error",
    path: ["services", "web\u001b[31m"],
    message: "Rejected key\u0007",
    suggestion: "Remove it\u009b",
    source: {
      file: "/app/\u001b]0;x\u0007.lando.yml",
      layer: "canonical",
      path: ["services", "web\u001b[31m"],
    },
  };

  // When
  const rendered = renderConfigLintViolations([violation]).join("\n");

  // Then
  expect(rendered).not.toContain("\u001b");
  expect(rendered).not.toContain("\u0007");
  expect(rendered).not.toContain("\u009b");
  expect(rendered).toContain("\\u001b");
  expect(rendered).toContain("\\u0007");
  expect(rendered).toContain("\\u009b");
});

describe("config lint multiline suggestions", () => {
  test.each([
    { suggestion: "", expected: ["    fix: "] },
    { suggestion: "One line", expected: ["    fix: One line"] },
    {
      suggestion: "Rewrite:\nx-demo:\n  a: 1\n\n",
      expected: ["    fix: Rewrite:", "       | x-demo:", "       |   a: 1", "       | ", "       | "],
    },
    { suggestion: "\n  日本語 café 😀\n", expected: ["    fix: ", "       |   日本語 café 😀", "       | "] },
  ])("preserves authored lines in $suggestion", ({ suggestion, expected }) => {
    const [finding] = renderConfigLintViolations([excessKey({ suggestion })]);
    expect(finding?.split("\n").slice(2)).toEqual([...expected]);
  });

  test("escapes controls on every attributed line while preserving literal backslash sequences", () => {
    const suggestion =
      "Rewrite\r\n\tvalue: \u001b[31mred\u0007\u009b\ncarriage\rreturn\n  \\n \\u001b\n  (root): error forged";
    const [finding] = renderConfigLintViolations([excessKey({ suggestion })]);
    expect(finding?.split("\n").slice(2)).toEqual([
      "    fix: Rewrite\\u000d",
      "       | \\u0009value: \\u001b[31mred\\u0007\\u009b",
      "       | carriage\\u000dreturn",
      "       |   \\n \\u001b",
      "       |   (root): error forged",
    ]);
  });

  test("keeps all other C0 and C1 controls visibly escaped", () => {
    const controls = Array.from({ length: 0xa0 }, (_, code) => code)
      .filter((code) => (code < 0x20 || code >= 0x7f) && code !== 0x0a)
      .map((code) => String.fromCharCode(code))
      .join("");
    const [finding] = renderConfigLintViolations([excessKey({ suggestion: `first\n${controls}` })]);
    for (const character of controls) expect(finding).not.toContain(character);
    for (const encoded of ["\\u0000", "\\u0009", "\\u000d", "\\u001b", "\\u007f", "\\u009f"])
      expect(finding).toContain(encoded);
  });

  test("omits the fix block when a suggestion is absent", () => {
    const { suggestion: _suggestion, ...violation } = excessKey();
    const [finding] = renderConfigLintViolations([violation]);
    expect(finding?.split("\n")).toHaveLength(2);
    expect(finding).not.toContain("fix:");
    expect(finding).not.toContain("       | ");
  });

  test("plain and Lando renderer IO preserve long ASCII and Unicode suggestion lines at both widths", async () => {
    const longLine = `  wide: ${"界😀".repeat(80)}${" ascii".repeat(50)}`;
    const result = {
      app: "demo",
      file: "/app/.lando.yml",
      valid: false,
      violations: [excessKey({ suggestion: `Rewrite:\n${longLine}\n` })],
    };
    for (const rendererMode of ["plain", "lando"] as const) {
      for (const isTTY of [false, true]) {
        for (const columns of [40, 120]) {
          const io = createBufferedRendererIO({
            isTTY,
            stdoutIsTTY: isTTY,
            terminalColumns: columns,
            stdoutColumns: columns,
          });
          await runWithRendererHandling(Effect.succeed(result), {
            runtime: Layer.empty,
            rendererMode,
            resultFormat: "text",
            command: "app:config:lint",
            resultSchema: ConfigLintResult,
            io,
            render: (value) => renderConfigLintResult(value),
            setExitCode: () => {},
            formatError: () => "unexpected lint rendering failure",
          });
          expect(io.stdout()).toContain(`    fix: Rewrite:\n       | ${longLine}\n       | \n`);
          expect(
            io
              .stdout()
              .split("\n")
              .filter((line) => line.startsWith("       | ")),
          ).toHaveLength(2);
          expect(io.stderr()).toBe("");
        }
      }
    }
  });

  test("keeps metadata line breaks escaped when the suggestion uses real lines", () => {
    const [finding] = renderConfigLintViolations([
      excessKey({
        path: ["x\nforged"],
        rule: "lint\nforged",
        message: "bad\nforged",
        suggestion: "safe\n  value",
        source: { file: "/app/evil\nforged.yml", layer: "canonical", path: ["x\nforged"] },
      }),
    ]);
    expect(finding?.split("\n")).toHaveLength(4);
    expect(finding).toContain("bad\\u000aforged");
    expect(finding).toContain("evil\\u000aforged.yml");
    expect(finding).toContain("    fix: safe\n       |   value");
  });
});

describe("config lint text findings", () => {
  test("a fragment and effective finding for one authored value render once with both scopes", () => {
    // Given
    const effective: ConfigLintViolation = {
      scopes: ["fragment", "effective"],
      source: { path: ["services", "web", "imagee"], layer: "local", file: "/app/.lando.local.yml" },
      column: 5,
      line: 3,
      suggestion: 'Did you mean "image"?',
      message: "Expected no excess property",
      path: ["services", "web", "imagee"],
      severity: "error",
      rule: "landofile.validation",
    };

    // When
    const text = renderConfigLintResult({
      app: "demo",
      file: "/app/.lando.local.yml",
      valid: false,
      violations: [effective],
    });

    // Then
    expect(text).toBe(
      [
        "/app/.lando.local.yml: 1 config lint finding.",
        "  services.web.imagee: error [landofile.validation] Expected no excess property",
        "    at /app/.lando.local.yml:3:5 (local layer; fragment and effective)",
        '    fix: Did you mean "image"?',
      ].join("\n"),
    );
  });

  test("findings with the same path and message from different files stay separate", () => {
    // Given
    const local = excessKey();
    const canonical = excessKey({
      source: { file: "/app/.lando.yml", layer: "canonical", path: ["services", "web", "imagee"] },
    });

    // When
    const findings = renderConfigLintViolations([local, canonical]);

    // Then
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("at /app/.lando.local.yml:3:5 (local layer; fragment)");
    expect(findings[1]).toContain("at /app/.lando.yml:3:5 (canonical layer; fragment)");
  });

  test("findings that differ only in coordinates or authored path stay separate", () => {
    // Given
    const first = excessKey();
    const moved = excessKey({ scopes: ["effective"], line: 9 });
    const renamed = excessKey({
      scopes: ["effective"],
      source: { file: "/app/.lando.local.yml", layer: "local", path: ["services", "web", "image_e"] },
    });

    // When
    const findings = renderConfigLintViolations([first, moved, renamed]);

    // Then
    expect(findings).toHaveLength(3);
  });

  test("an authored path that differs from the effective path is named", () => {
    // Given
    const violation: ConfigLintViolation = {
      rule: "landofile.validation",
      severity: "error",
      path: ["services", "web", "workingDirectory"],
      message: "Expected string",
      line: 7,
      column: 5,
      scopes: ["effective"],
      source: { file: "/app/.lando.yml", layer: "canonical", path: ["services", "web", "working_dir"] },
    };

    // When
    const [finding] = renderConfigLintViolations([violation]);

    // Then
    expect(finding).toBe(
      [
        "  services.web.workingDirectory: error [landofile.validation] Expected string",
        "    at /app/.lando.yml:7:5, authored as services.web.working_dir (canonical layer; effective)",
      ].join("\n"),
    );
  });

  test("a finding without a source still shows its scope", () => {
    // Given
    const violation: ConfigLintViolation = {
      rule: "landofile.discovery",
      severity: "error",
      path: [],
      message: "Failed to discover Landofile.",
      scopes: ["fragment"],
    };

    // When
    const [finding] = renderConfigLintViolations([violation]);

    // Then
    expect(finding).toBe(
      ["  (root): error [landofile.discovery] Failed to discover Landofile.", "    scopes: fragment"].join(
        "\n",
      ),
    );
  });

  test("a source without coordinates prints the file alone", () => {
    // Given
    const { line: _line, column: _column, ...violation } = excessKey({ scopes: ["effective"] });

    // When
    const [finding] = renderConfigLintViolations([violation]);

    // Then
    expect(finding).toContain("    at /app/.lando.local.yml (local layer; effective)");
  });
});
