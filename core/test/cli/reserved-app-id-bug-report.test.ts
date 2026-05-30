import { describe, expect, test } from "bun:test";

import { AppIdReservedError } from "@lando/sdk/errors";

import { buildBugReport } from "../../src/cli/bug-report.ts";

const context = { commandId: "start", cacheRoot: "/tmp/lando-cache" };

describe("AppIdReservedError bug report", () => {
  test("derives a human message and remediation when no message field is present", () => {
    const envelope = buildBugReport({
      error: new AppIdReservedError({ reserved: "global" }),
      context,
    });

    expect(envelope.code).toBe("AppIdReservedError");
    expect(envelope.body).toContain("reserved for the global Lando app");
    expect(envelope.body).not.toContain("{");
    expect(envelope.remediation).toBeDefined();
    expect(envelope.extra).toContainEqual(["reserved", "global"]);
  });

  test("surfaces the suggested name in the remediation", () => {
    const envelope = buildBugReport({
      error: new AppIdReservedError({ reserved: "global", suggested: "my-app" }),
      context,
    });

    expect(envelope.remediation).toContain("my-app");
    expect(envelope.extra).toContainEqual(["suggested", "my-app"]);
  });
});
