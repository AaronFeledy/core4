import { expect, test } from "bun:test";
import { parseLockEntriesFromText } from "../src/include-lockfile.ts";

test("parseLockEntriesFromText is exported and decodes lock entries", () => {
  const commit = "a".repeat(40);
  const checksum = "b".repeat(64);
  const entries = parseLockEntriesFromText(
    [
      "includes:",
      "  - source: github:acme/shared/php.yml",
      `    resolved: ${commit}`,
      `    checksum: ${checksum}`,
      "",
    ].join("\n"),
  );
  expect(entries).toEqual([{ source: "github:acme/shared/php.yml", resolved: commit, checksum }]);
  expect(() => parseLockEntriesFromText("not-a-lockfile\n")).toThrow();
});
