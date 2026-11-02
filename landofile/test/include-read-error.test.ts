import { expect, test } from "bun:test";
import { readText } from "../src/include-local.ts";
import { includeReadError } from "../src/include-read-error.ts";

test.each([
  ["ENOENT", "does not exist"],
  ["EACCES", "is not readable (permission denied)"],
  ["EPERM", "is not readable (permission denied)"],
  ["EISDIR", "is a directory"],
  ["EIO", "could not be read (EIO)"],
  ["SECRET_CONTENT", "could not be read"],
  [undefined, "could not be read"],
])("reports safe include read diagnostics for %s", (code, reason) => {
  // Given: an OS boundary failure whose message must never be disclosed.
  const cause = Object.assign(new Error("private contents and repeated /app/fragment.yml"), { code });
  // When
  const error = includeReadError("/app/fragment.yml", "./fragment.yml", cause);
  // Then
  expect(error.message).toBe(`Include ./fragment.yml at /app/fragment.yml ${reason}.`);
});

test("names an identical authored and resolved include path once", () => {
  // Given
  const cause = Object.assign(new Error("private"), { code: "ENOENT" });
  // When
  const error = includeReadError("/app/fragment.yml", "/app/fragment.yml", cause);
  // Then
  expect(error.message).toBe("Include /app/fragment.yml does not exist.");
});

test("maps a real missing fragment through the shared read boundary", async () => {
  // Given
  const path = `/tmp/lando-missing-${crypto.randomUUID()}.yml`;
  // When / Then
  await expect(readText(path, "./missing.yml")).rejects.toMatchObject({
    _tag: "LandofileIncludeError",
    kind: "fetch-failed",
    message: `Include ./missing.yml at ${path} does not exist.`,
  });
});
