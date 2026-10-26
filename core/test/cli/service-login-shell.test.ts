import { describe, expect, test } from "bun:test";

import { DEFAULT_SERVICE_LOGIN_SHELL, serviceLoginShellCommand } from "../../src/cli/service-login-shell.ts";

describe("service login shell", () => {
  test("prefers bash when present and falls back to sh", () => {
    expect(DEFAULT_SERVICE_LOGIN_SHELL).toEqual([
      "sh",
      "-c",
      "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l",
    ]);
  });

  test("uses the default when no override is supplied", () => {
    expect(serviceLoginShellCommand(undefined)).toEqual(DEFAULT_SERVICE_LOGIN_SHELL);
    expect(serviceLoginShellCommand([])).toEqual(DEFAULT_SERVICE_LOGIN_SHELL);
  });

  test("respects an explicit command override", () => {
    expect(serviceLoginShellCommand(["zsh", "-l"])).toEqual(["zsh", "-l"]);
    expect(serviceLoginShellCommand(["sh", "-l"])).toEqual(["sh", "-l"]);
  });
});
