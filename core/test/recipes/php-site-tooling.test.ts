import { describe, expect, test } from "bun:test";
import { composerAndPhpTooling } from "../../src/recipes/builtin/php-stack.ts";

describe("composer and PHP tooling", () => {
  test("preserves the complete fragment and key order when Composer is enabled", () => {
    const tooling = composerAndPhpTooling(true, { service: "appserver" });
    expect(tooling).toEqual({
      composer: {
        service: "appserver",
        description: "Run Composer inside the appserver service.",
        cmds: ["composer"],
      },
      php: {
        service: "appserver",
        description: "Run the PHP CLI inside the appserver service.",
        cmds: ["php"],
      },
    });
    expect(Object.keys(tooling)).toEqual(["composer", "php"]);
  });

  test("omits the composer key when Composer is disabled", () => {
    const tooling = composerAndPhpTooling(false);
    expect(tooling).toEqual({
      php: {
        service: "appserver",
        description: "Run the PHP CLI inside the appserver service.",
        cmds: ["php"],
      },
    });
    expect(Object.hasOwn(tooling, "composer")).toBe(false);
  });

  test("uses the selected service in both tooling entries", () => {
    const tooling = composerAndPhpTooling(true, { service: "worker" });
    expect(tooling).toEqual({
      composer: {
        service: "worker",
        description: "Run Composer inside the worker service.",
        cmds: ["composer"],
      },
      php: {
        service: "worker",
        description: "Run the PHP CLI inside the worker service.",
        cmds: ["php"],
      },
    });
  });

  test("allocates independent fragments and command arrays on successive calls", () => {
    const first = composerAndPhpTooling(true);
    const second = composerAndPhpTooling(true);
    expect(first).not.toBe(second);
    expect(first.composer).not.toBe(second.composer);
    expect(first.composer?.cmds).not.toBe(second.composer?.cmds);
    expect(first.php).not.toBe(second.php);
    expect(first.php.cmds).not.toBe(second.php.cmds);
  });
});
