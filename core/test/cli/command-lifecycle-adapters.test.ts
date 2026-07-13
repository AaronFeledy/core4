import { afterEach, describe, expect, test } from "bun:test";

import { resolveCanonicalCommandId } from "../../src/cli/cli-adapters/meta-plugin.ts";
import { landoSpecForId } from "../../src/cli/compiled-argv.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import {
  getActiveCommandInvocation,
  resetActiveCommandInvocation,
  setActiveCommandId,
} from "../../src/cli/compiled-runtime.ts";

afterEach(() => {
  setActiveCommandId("cli:unknown");
  resetActiveCommandInvocation("cli:unknown", []);
});

describe("CLI lifecycle adapters", () => {
  test("compiled alias input retains the canonical command identity", () => {
    // Given
    const commandId = resolveCanonicalCommandId("start");
    setActiveCommandId(commandId);
    resetActiveCommandInvocation(commandId, []);

    // When
    const input = compiledCommandInputFromArgv(commandId, []);

    // Then
    expect(input.args).toEqual({});
    expect(getActiveCommandInvocation()).toMatchObject({
      commandId: "app:start",
      argv: [],
      args: {},
    });
  });

  test("representative command specs retain every lifecycle bootstrap depth", () => {
    // Given / When
    const declarations = [
      ["meta:version", landoSpecForId("meta:version")?.bootstrap],
      ["meta:update", landoSpecForId("meta:update")?.bootstrap],
      ["meta:doctor", landoSpecForId("meta:doctor")?.bootstrap],
      ["app:start", landoSpecForId("app:start")?.bootstrap],
    ];

    // Then
    expect(declarations).toEqual([
      ["meta:version", "none"],
      ["meta:update", "plugins"],
      ["meta:doctor", "provider"],
      ["app:start", "app"],
    ]);
  });

  test("every result-driven nonzero exit declares its lifecycle exit-code policy", () => {
    const ids = [
      "app:config:lint",
      "app:includes:update",
      "app:includes:verify",
      "app:exec",
      "app:ssh",
      "app:shell",
      "meta:uninstall",
    ];

    expect(ids.filter((id) => landoSpecForId(id)?.successExitCode === undefined)).toEqual([]);
  });
});
