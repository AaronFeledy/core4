import { describe, expect, test } from "bun:test";

import { cliUserArgv } from "../../src/cli/user-argv.ts";

describe("cliUserArgv", () => {
  test("drops the Bun source entry path", () => {
    expect(cliUserArgv(["/usr/bin/bun", "/repo/core/bin/lando.ts", "start", "--yes"])).toEqual([
      "start",
      "--yes",
    ]);
  });

  test("drops a compiled $bunfs entry path", () => {
    expect(cliUserArgv(["/usr/local/bin/lando", "/$bunfs/root/core/bin/lando.ts", "start"])).toEqual([
      "start",
    ]);
  });

  test("keeps a compiled worker command when no entry path is injected", () => {
    expect(cliUserArgv(["/usr/local/bin/lando", "__internal:host-proxy-worker", "--app-id", "demo"])).toEqual(
      ["__internal:host-proxy-worker", "--app-id", "demo"],
    );
  });

  test("still drops an injected entry in front of the worker command", () => {
    expect(
      cliUserArgv([
        "/usr/local/bin/lando",
        "/$bunfs/root/core/bin/lando.ts",
        "__internal:host-proxy-worker",
        "--app-id",
        "demo",
      ]),
    ).toEqual(["__internal:host-proxy-worker", "--app-id", "demo"]);
  });
});
