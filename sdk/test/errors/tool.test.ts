import { describe, expect, test } from "bun:test";

import { ToolExtractError, ToolInstallPathError, ToolManifestError } from "@lando/sdk/errors";

describe("ToolManifestError", () => {
  test("is a tagged error carrying tool/host context and remediation", () => {
    const error = new ToolManifestError({
      message: 'No artifact entry for host "linux-x64".',
      toolId: "mutagen",
      key: "linux-x64",
      remediation: "Run `lando setup` on a supported host or update the bundled manifest.",
    });

    expect(error._tag).toBe("ToolManifestError");
    expect(error.toolId).toBe("mutagen");
    expect(error.key).toBe("linux-x64");
    expect(error.message).toContain("linux-x64");
    expect(error.remediation).toContain("lando setup");
  });
});

describe("ToolExtractError", () => {
  test("is a tagged error carrying the member and remediation", () => {
    const error = new ToolExtractError({
      message: 'Member "mutagen" not found in archive.',
      toolId: "mutagen",
      member: "mutagen",
      remediation: "Retry `lando setup`; if it persists report the archive URL.",
      cause: new Error("missing"),
    });

    expect(error._tag).toBe("ToolExtractError");
    expect(error.toolId).toBe("mutagen");
    expect(error.member).toBe("mutagen");
    expect(error.remediation).toContain("lando setup");
  });
});

describe("ToolInstallPathError", () => {
  test("is a tagged error carrying the escaping install name", () => {
    const error = new ToolInstallPathError({
      message: 'Install name "../evil" escapes the bin directory.',
      toolId: "mutagen",
      installName: "../evil",
      remediation: "Use an install name contained within the bin directory.",
    });

    expect(error._tag).toBe("ToolInstallPathError");
    expect(error.toolId).toBe("mutagen");
    expect(error.installName).toBe("../evil");
    expect(error.remediation).toContain("contained");
  });
});
