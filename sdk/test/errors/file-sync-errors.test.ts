import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";

describe("FileSyncStartError (§10.6.1)", () => {
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
    const decoded = Schema.decodeUnknownEither(FileSyncStartError)({
      _tag: "FileSyncStartError",
      engineId: "mutagen",
      message: "binary missing",
      sessionSpec: { app: "myapp", service: "web", mountKey: "app-root" },
      remediation: "Run lando setup",
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.engineId).toBe("mutagen");
      expect(decoded.right.sessionSpec).toEqual({
        app: "myapp",
        service: "web",
        mountKey: "app-root",
      });
    }
  });

  test("accepts an absent optional sessionSpec field", () => {
    const error = new FileSyncStartError({
      engineId: "passthrough",
      message: "engine not ready",
    });

    expect(error.sessionSpec).toBeUndefined();
    expect(error.remediation).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});

describe("FileSyncDriftError (§10.6.1 — conflict reporting)", () => {
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
    const decoded = Schema.decodeUnknownEither(FileSyncDriftError)({
      _tag: "FileSyncDriftError",
      engineId: "mutagen",
      message: "drift detected",
      sessionRef: "session-xyz",
      conflictedPaths: ["a", "b"],
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.sessionRef).toBe("session-xyz");
      expect(decoded.right.conflictedPaths).toEqual(["a", "b"]);
      expect(decoded.right.suggestedMode).toBeUndefined();
    }
  });

  test("accepts an absent suggestedMode field", () => {
    const error = new FileSyncDriftError({
      engineId: "mutagen",
      message: "drift detected",
      sessionRef: "session-xyz",
      conflictedPaths: [],
    });

    expect(error.suggestedMode).toBeUndefined();
  });
});

describe("FileSyncStopError (§10.6.1 — terminate failure)", () => {
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
    const decoded = Schema.decodeUnknownEither(FileSyncStopError)({
      _tag: "FileSyncStopError",
      engineId: "mutagen",
      sessionRef: "session-xyz",
      message: "terminate failed",
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.sessionRef).toBe("session-xyz");
      expect(decoded.right.remediation).toBeUndefined();
    }
  });
});
