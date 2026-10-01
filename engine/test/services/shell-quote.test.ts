import { describe, expect, test } from "bun:test";

import { quoteShellPath, shellArg } from "../../src/services/shell-quote.ts";

describe("shellArg", () => {
  test.each([
    ["posix", "/tmp/lando-app_1.2"],
    ["windows", "C:\\Users\\me\\lando-app_1.2"],
  ] as const)("leaves a plain %s path bare so printed commands stay readable", (shell, path) => {
    expect(shellArg(path, shell)).toBe(path);
  });

  test("POSIX-quotes a path the shell would split or expand", () => {
    expect(shellArg("/home/me/My Apps/site", "posix")).toBe("'/home/me/My Apps/site'");
    expect(shellArg("/tmp/$HOME", "posix")).toBe("'/tmp/$HOME'");
    expect(shellArg("/tmp/it's", "posix")).toBe(quoteShellPath("/tmp/it's"));
    expect(shellArg("/tmp/it's", "posix")).toBe("'/tmp/it'\\''s'");
  });

  test("double-quotes a Windows path so cmd.exe and PowerShell both read one argument", () => {
    expect(shellArg("C:\\Users\\John Smith\\site", "windows")).toBe('"C:\\Users\\John Smith\\site"');
    expect(shellArg("C:\\Users\\O'Brien\\site", "windows")).toBe(`"C:\\Users\\O'Brien\\site"`);
  });

  test("double-quotes a Windows comma path PowerShell would split into an array", () => {
    expect(shellArg("C:\\a,b", "windows")).toBe('"C:\\a,b"');
  });

  test("leaves a POSIX comma path bare", () => {
    expect(shellArg("/a,b", "posix")).toBe("/a,b");
  });

  test("single-quotes a Windows path PowerShell would expand inside double quotes", () => {
    expect(shellArg("C:\\apps\\$(calc)", "windows")).toBe("'C:\\apps\\$(calc)'");
    expect(shellArg("C:\\apps\\it's $x", "windows")).toBe("'C:\\apps\\it''s $x'");
  });
});
