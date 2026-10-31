import { describe, expect, test } from "bun:test";

import type { RecipePrompt } from "@lando/sdk/schema";

import { appNamePromptChrome } from "../../src/cli/commands/init-app-name-chrome.ts";
import { defaultAppNameFromCwd, withAppNameDefault } from "../../src/cli/commands/init-app-name.ts";

describe("defaultAppNameFromCwd", () => {
  test("uses a kebab-case folder name as-is", () => {
    expect(defaultAppNameFromCwd("/tmp/my-site")).toBe("my-site");
  });

  test("slugifies mixed-case and spaced folder names", () => {
    expect(defaultAppNameFromCwd("/tmp/My Site")).toBe("my-site");
  });

  test("prefixes a letter when the slug would start with a digit", () => {
    expect(defaultAppNameFromCwd("/tmp/123foo")).toBe("app-123foo");
  });

  test("falls back when the folder name has no usable characters", () => {
    expect(defaultAppNameFromCwd("/tmp/...")).toBe("app");
    expect(defaultAppNameFromCwd("/")).toBe("app");
  });
});

describe("withAppNameDefault", () => {
  const namePrompt = {
    name: "name",
    type: "text",
    message: "App name",
  } as const satisfies RecipePrompt;

  test("injects the folder name when the name prompt has no default", () => {
    const [prompt] = withAppNameDefault([namePrompt], "/tmp/my-site");
    expect(prompt?.default).toBe("my-site");
  });

  test("leaves a recipe-authored name default in place", () => {
    const [prompt] = withAppNameDefault([{ ...namePrompt, default: "toolbox" }], "/tmp/my-site");
    expect(prompt?.default).toBe("toolbox");
  });

  test("does not invent a default for non-name prompts", () => {
    const other = { name: "database", type: "select", message: "Database", choices: ["postgres"] } as const;
    const [prompt] = withAppNameDefault([other], "/tmp/my-site");
    expect(prompt?.default).toBeUndefined();
  });
});

describe("appNamePromptChrome", () => {
  const appRoot = "/tmp/my-site";

  test("footer slug follows the planner slug, not the raw typed value", () => {
    const chrome = appNamePromptChrome({ appRoot });
    const machine = chrome.footer?.find((line) => line.id === "machine-name");
    expect(machine?.render("My Site")).toContain("my-site");
  });

  test("offers only machine-name chrome before preparation", () => {
    const chrome = appNamePromptChrome({ appRoot });
    expect(chrome.footer?.map(({ id }) => id)).toEqual(["machine-name"]);
  });
});
