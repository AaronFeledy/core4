import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { initOptionsFromInput } from "../../src/cli/oclif/commands/apps/init.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";

describe("OCLIF init adapter", () => {
  test("resolves a relative positional destination from the current working directory", () => {
    const input = compiledCommandInputFromArgv("apps:init", ["sites/drupal"]);

    const options = initOptionsFromInput(input);

    expect(options.destination).toBe(resolve(process.cwd(), "sites/drupal"));
  });

  test("preserves an absolute positional destination", () => {
    const destination = resolve(process.cwd(), "sites/drupal");
    const input = { args: { destination }, flags: {} };

    const options = initOptionsFromInput(input);

    expect(options.destination).toBe(destination);
  });

  test("defaults destination to the app name when supplied", () => {
    const input = { args: {}, flags: { name: "named-app" } };

    const options = initOptionsFromInput(input);

    expect(options.destination).toBe(resolve(process.cwd(), "named-app"));
  });

  test("defaults destination to the current working directory", () => {
    const input = { args: {}, flags: {} };

    const options = initOptionsFromInput(input);

    expect(options.destination).toBe(process.cwd());
  });
});
