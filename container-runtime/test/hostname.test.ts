import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { containerHostname, serviceContainerHostname } from "../src/hostname.ts";

describe("containerHostname", () => {
  test.each(["lando-foo-web", "lando-Foo-Web", "a", "a".repeat(63)])(
    "preserves the valid DNS label %s verbatim",
    (name) => {
      expect(containerHostname(name)).toBe(name);
    },
  );

  test.each(["lando-foo-web_1", "lando-foo-a.b", "a".repeat(64), `${"a".repeat(53)}-${"b".repeat(20)}`])(
    "hashes the original name when %s needs a DNS fallback",
    (name) => {
      // Given an engine name that cannot be used as one DNS label.
      const hash = sha256Hex(name).slice(0, 8);
      // When
      const hostname = containerHostname(name);
      // Then
      expect(hostname).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
      expect(hostname.length).toBeLessThanOrEqual(63);
      expect(hostname.startsWith(hash)).toBe(true);
    },
  );

  test.each([
    ["lando-foo-web_1", "lando-foo-web-1"],
    ["lando-foo-a.b", "lando-foo-a-b"],
    ["lando-foo-web_1", `lando-foo-web-1-${sha256Hex("lando-foo-web_1").slice(0, 8)}`],
    [`${"a".repeat(63)}-alpha`, `${"a".repeat(63)}-beta`],
  ])("keeps %s distinct from %s", (left, right) => {
    expect(containerHostname(left)).not.toBe(containerHostname(right));
  });

  test("uses the planned service's container name", () => {
    expect(serviceContainerHostname({ slug: "myapp" }, "web")).toBe("lando-myapp-web");
  });
});
