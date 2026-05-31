import { describe, expect, test } from "bun:test";

import {
  ScratchAppIdInvalidError,
  ScratchAppNotFoundError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";

describe("scratch tagged errors", () => {
  test("ScratchSourceUnresolvedError carries an explicit message", () => {
    const error = new ScratchSourceUnresolvedError({
      message: "Scratch source could not be resolved.",
      source: "unresolved",
      attempts: [],
      remediation: "Choose a scratch source before starting a scratch app.",
    });

    expect(error._tag).toBe("ScratchSourceUnresolvedError");
    expect(error.message).toBe("Scratch source could not be resolved.");
    expect(error.remediation).toBe("Choose a scratch source before starting a scratch app.");
  });

  test("ScratchAppNotFoundError carries an explicit message", () => {
    const error = new ScratchAppNotFoundError({
      message: "Scratch app missing was not found.",
      id: "missing",
      suggestions: [],
      remediation: "Run `lando apps:scratch:list` to see currently registered scratch apps.",
    });

    expect(error._tag).toBe("ScratchAppNotFoundError");
    expect(error.message).toBe("Scratch app missing was not found.");
    expect(error.remediation).toBe("Run `lando apps:scratch:list` to see currently registered scratch apps.");
  });

  test("ScratchAppIdInvalidError carries an explicit message", () => {
    const error = new ScratchAppIdInvalidError({
      message: "A scratch app id is required.",
      id: "",
      remediation: "Pass a scratch id.",
    });

    expect(error._tag).toBe("ScratchAppIdInvalidError");
    expect(error.message).toBe("A scratch app id is required.");
    expect(error.remediation).toBe("Pass a scratch id.");
  });
});
