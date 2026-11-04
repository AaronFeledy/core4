import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";

describe("FileSyncStartError", () => {
  test("carries engineId, message, redactable sessionSpec, remediation, cause", () => {
    const error = new FileSyncStartError({
      engineId: "mutagen",
      message: "createSession failed",
      sessionSpec: { app: "myapp", service: "web", mountKey: "app-root" },
      remediation: "Run lando setup --provider=mutagen",
      cause: new Error("daemon refused"),
    });

    expect(error._tag).toBe("FileSyncStartError");
    expect(error.engineId).toBe("mutagen");
    expect(error.message).toBe("createSession failed");
    expect(error.sessionSpec).toEqual({ app: "myapp", service: "web", mountKey: "app-root" });
    expect(error.remediation).toBe("Run lando setup --provider=mutagen");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("decodes through schema preserving every documented field", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncStartError)({
      _tag: "FileSyncStartError",
      engineId: "mutagen",
      message: "binary missing",
      sessionSpec: { app: "myapp", service: "web", mountKey: "app-root" },
      remediation: "Run lando setup",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.engineId).toBe("mutagen");
      expect(decoded.success.sessionSpec).toEqual({
        app: "myapp",
        service: "web",
        mountKey: "app-root",
      });
    }
  });

  test("accepts an absent optional sessionSpec field when remediation is provided", () => {
    const error = new FileSyncStartError({
      engineId: "passthrough",
      message: "engine not ready",
      remediation: "Wait until the file-sync engine reports ready, then retry `lando start`.",
    });

    expect(error.sessionSpec).toBeUndefined();
    expect(error.remediation).toContain("file-sync engine");
    expect(error.cause).toBeUndefined();
  });
});

describe("FileSyncDriftError", () => {
  test("carries engineId, sessionRef, conflictedPaths, suggestedMode, remediation, cause", () => {
    const error = new FileSyncDriftError({
      engineId: "mutagen",
      message: "two-way conflict on README.md",
      sessionRef: "myapp-web-app-root",
      conflictedPaths: ["README.md", "src/foo.ts"],
      suggestedMode: "two-way-resolved",
      remediation: "Resolve the listed paths or switch to two-way-resolved mode.",
      cause: new Error("path divergence"),
    });

    expect(error._tag).toBe("FileSyncDriftError");
    expect(error.engineId).toBe("mutagen");
    expect(error.sessionRef).toBe("myapp-web-app-root");
    expect(error.conflictedPaths).toEqual(["README.md", "src/foo.ts"]);
    expect(error.suggestedMode).toBe("two-way-resolved");
    expect(error.remediation).toContain("two-way-resolved");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("decodes through schema preserving sessionRef and conflictedPaths", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncDriftError)({
      _tag: "FileSyncDriftError",
      engineId: "mutagen",
      message: "drift detected",
      sessionRef: "session-xyz",
      conflictedPaths: ["a", "b"],
      remediation: "Resolve the listed conflicted paths, then retry `lando start`.",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.sessionRef).toBe("session-xyz");
      expect(decoded.success.conflictedPaths).toEqual(["a", "b"]);
      expect(decoded.success.suggestedMode).toBeUndefined();
    }
  });

  test("accepts an absent suggestedMode field", () => {
    const error = new FileSyncDriftError({
      engineId: "mutagen",
      message: "drift detected",
      sessionRef: "session-xyz",
      conflictedPaths: [],
      remediation: "Remove the stale sync session before running lando start again.",
    });

    expect(error.suggestedMode).toBeUndefined();
  });
});

describe("FileSyncStopError", () => {
  test("carries engineId, sessionRef, message, remediation, cause", () => {
    const error = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: "myapp-web-app-root",
      message: "terminate timed out",
      remediation: "Run lando apps poweroff to clear daemon state.",
      cause: new Error("ETIMEDOUT"),
    });

    expect(error._tag).toBe("FileSyncStopError");
    expect(error.engineId).toBe("mutagen");
    expect(error.sessionRef).toBe("myapp-web-app-root");
    expect(error.message).toBe("terminate timed out");
    expect(error.remediation).toContain("poweroff");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("decodes through schema preserving sessionRef", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncStopError)({
      _tag: "FileSyncStopError",
      engineId: "mutagen",
      sessionRef: "session-xyz",
      message: "terminate failed",
      remediation: "Inspect the file-sync engine log, then retry `lando stop`.",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.sessionRef).toBe("session-xyz");
      expect(decoded.success.remediation).toContain("lando stop");
    }
  });
});
