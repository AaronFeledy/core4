import { describe, expect, test } from "bun:test";

import { quoteShellPath, shellArg } from "../../src/services/shell-quote.ts";

describe("shellArg", () => {
  test("leaves a plain path bare so printed commands stay readable", () => {
    expect(shellArg("/tmp/lando-app_1.2")).toBe("/tmp/lando-app_1.2");
  });

  test("quotes a path that the shell would split or expand", () => {
    expect(shellArg("/home/me/My Apps/site")).toBe("'/home/me/My Apps/site'");
    expect(shellArg("/tmp/$HOME")).toBe("'/tmp/$HOME'");
  });

  test("escapes embedded single quotes the same way quoteShellPath does", () => {
    expect(shellArg("/tmp/it's")).toBe(quoteShellPath("/tmp/it's"));
    expect(shellArg("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });
});
