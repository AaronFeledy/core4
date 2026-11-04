import { describe, expect, test } from "bun:test";
import { SourceAcquisitionError, acquisitionError, displaySource } from "../src/errors.ts";

describe("displaySource", () => {
  test("strips credentials query and hash from URLs", () => {
    expect(displaySource("clone https://user:p@ss@github.com/org/repo.git?token=1#frag failed")).toBe(
      "clone https://github.com/org/repo.git failed",
    );
  });
});

describe("acquisitionError", () => {
  test("typed transport kinds take precedence over auth-looking messages", () => {
    const error = acquisitionError(
      "fetch-failed",
      "https://user:secret@example.test/repo.git",
      Object.assign(new Error("permission denied (publickey) while reading package-not-found metadata"), {
        kind: "package-not-found",
      }),
    );
    expect(error.kind).toBe("not-found");
    expect(error.source).toBe("https://example.test/repo.git");
    expect(error.message).not.toContain("secret");
  });

  test("auth only matches precise git signatures against URL-stripped text", () => {
    const auth = acquisitionError(
      "fetch-failed",
      "git@example.test:org/repo.git",
      "Permission denied (publickey)",
    );
    expect(auth.kind).toBe("auth");

    const notAuth = acquisitionError(
      "fetch-failed",
      "https://registry.npmjs.org/@scope/pkg",
      "GET https://user:token@registry.npmjs.org/v1/auth/token failed with 500",
    );
    expect(notAuth.kind).toBe("fetch-failed");
    expect(notAuth.message).not.toContain("user:");
    expect(notAuth.message).toContain("https://registry.npmjs.org/v1/auth/token");
  });

  test("preserves download and metadata phases from typed causes", () => {
    const download = acquisitionError(
      "fetch-failed",
      "@acme/pkg",
      Object.assign(new Error("Could not download npm tarball"), { kind: "download-failed" }),
    );
    expect(download.kind).toBe("fetch-failed");
    expect(download.phase).toBe("download");

    const metadata = acquisitionError(
      "fetch-failed",
      "@acme/pkg",
      Object.assign(new Error("Could not fetch npm metadata"), { kind: "registry-failed" }),
    );
    expect(metadata.kind).toBe("fetch-failed");
    expect(metadata.phase).toBe("metadata");
  });

  test("re-wraps SourceAcquisitionError with displaySource only", () => {
    const original = new SourceAcquisitionError({
      kind: "auth",
      source: "https://user:pw@git.example/x.git",
      message: "Permission denied (publickey) for https://user:pw@git.example/x.git",
      remediation: "Use a credential helper.",
    });
    const wrapped = acquisitionError("fetch-failed", "ignored", original);
    expect(wrapped.kind).toBe("auth");
    expect(wrapped.source).toBe("https://git.example/x.git");
    expect(wrapped.message).not.toContain("pw");
  });
});

test.each([
  "Authentication failed",
  "could not read Username",
  "could not read Password",
  "Permission denied (publickey,keyboard-interactive)",
  "terminal prompts disabled",
  "HTTP Basic: Access denied",
  "The requested URL returned error: 401",
  "The requested URL returned error: 403",
])("git auth signature: %s", (message) => {
  expect(acquisitionError("fetch-failed", "git", message).kind).toBe("auth");
});

test.each([
  "Could not resolve host: https://git.example/auth-service.git",
  "Permission denied reading /tmp/source",
  "Could not resolve host: https://publickey.example/source.git",
])("ordinary transport failure permits stale fallback: %s", (message) => {
  expect(acquisitionError("fetch-failed", "git", message).kind).toBe("fetch-failed");
});

test("typed fetch failure takes precedence over a git auth signature", () => {
  expect(
    acquisitionError(
      "fetch-failed",
      "git",
      Object.assign(new Error("Authentication failed"), {
        kind: "fetch-failed",
      }),
    ).kind,
  ).toBe("fetch-failed");
});
