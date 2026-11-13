import { describe, expect, test } from "bun:test";
import { buildFailureRemediation, buildRemediationSuffix } from "../../src/services/build-remediation.ts";

describe("buildFailureRemediation", () => {
  test.each([
    ["user", "/tmp/build.log"],
    ["global", "/tmp/build.log"],
    ["scratch", undefined],
  ] as const)("joins the %s suffix without a trailing or doubled space", (kind, path) => {
    const text = buildFailureRemediation(
      "Base failure remediation.",
      buildRemediationSuffix(kind, "web", path),
    );

    expect(text).toBe(text.trim());
    expect(text).not.toContain("  ");
  });

  test("keeps a pathless global remediation exactly as written", () => {
    const text = buildFailureRemediation(
      "Base failure remediation.",
      buildRemediationSuffix("global", "web", undefined),
    );

    expect(text).toBe("Base failure remediation.");
  });

  test("names the scratch start command and no transcript path", () => {
    const suffix = buildRemediationSuffix("scratch", "web", "/tmp/build.log");

    expect(suffix).toContain("lando scratch:start --keep-on-failure");
    expect(suffix).not.toContain("/tmp/build.log");
  });

  test("ends a user remediation with the logs --build command", () => {
    const text = buildFailureRemediation(
      "Inspect the build transcript, fix the step, and rebuild.",
      buildRemediationSuffix("user", "web", "/tmp/build.log"),
    );

    expect(text).toEndWith('Run "lando logs --build --service web" to print it.');
  });

  test("does not double the space when the base already ends with one", () => {
    expect(buildFailureRemediation("Fix it. ", "Run it.")).toBe("Fix it. Run it.");
  });
});
