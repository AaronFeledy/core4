import { expect, test } from "bun:test";
import { FileIoError, safeFileIoError } from "@lando/sdk/errors";
import { Schema } from "effect";

test.each(["read", "stage", "persist"] as const)(
  "FileIoError preserves %s metadata on the wire",
  (operation) => {
    const wire = {
      _tag: "FileIoError",
      message: "Host storage is full.",
      path: "/host/dump.sql",
      operation,
      reason: "no-space",
      remediation: "Free host storage space.",
    };

    const decoded = Schema.decodeUnknownSync(FileIoError)(wire);

    expect(Schema.encodeSync(FileIoError)(decoded)).toEqual(wire);
  },
);

test("FileIoError accepts existing constructors without operation or reason", () => {
  const error = new FileIoError({ message: "Failed.", path: "/file", remediation: "Repair the file." });
  expect(Schema.encodeSync(FileIoError)(error)).toEqual({
    _tag: "FileIoError",
    message: "Failed.",
    path: "/file",
    remediation: "Repair the file.",
  });
});

for (const operation of ["read", "stage", "persist"] as const) {
  test.each([
    ["EACCES", "permission-denied", /ownership and permissions/u],
    ["EROFS", "read-only", /mount settings/u],
    ["ENOSPC", "no-space", /space or inodes/u],
    ["EDQUOT", "quota-exceeded", /quota increase/u],
    ["ENOENT", "not-found", /parent directories exist/u],
    ["ENOTDIR", "invalid-path", /directory components/u],
    ["EIO", "io", /storage device health/u],
    ["UNRECOGNIZED", "unknown", /filesystem is healthy/u],
  ] as const)(`${operation} builds safe actionable %s diagnostics`, (code, reason, action) => {
    const native = Object.assign(new Error("HOSTILE_MESSAGE"), {
      code,
      stack: "HOSTILE_STACK",
      payload: "HOSTILE_PAYLOAD",
      cause: { _tag: "Hostile", message: "HOSTILE_CAUSE" },
    });

    const error = safeFileIoError(operation, "/host/file", native);

    expect(error).toBeInstanceOf(FileIoError);
    expect(error).toMatchObject({ operation, reason, path: "/host/file" });
    expect(error.message).toContain(`Failed to ${operation} file at /host/file:`);
    expect(error.remediation).toMatch(action);
    expect(error.cause).toBeUndefined();
    expect(error).not.toHaveProperty("code");
    expect(`${error.stack}\n${JSON.stringify(error)}`).not.toMatch(/HOSTILE_/u);
  });
}

test.each([
  ["read", "readable source"],
  ["stage", "writable staging location"],
  ["persist", "writable destination location"],
] as const)("%s permission guidance identifies the path's role", (operation, location) => {
  const error = safeFileIoError(operation, "/host/file", { code: "EPERM" });
  expect(error.remediation).toContain(location);
});
