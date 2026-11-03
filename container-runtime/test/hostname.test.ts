import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { serviceContainerHostname } from "../src/hostname.ts";

const hostname = (service: string): string => serviceContainerHostname({ slug: "foo" }, service);
const nameHash = (service: string): string => sha256Hex(`lando-foo-${service}`).slice(0, 8);

describe("serviceContainerHostname", () => {
  test.each(["web", "Web", "foo-web"])("uses the container name for service %s", (service) => {
    expect(hostname(service)).toBe(`lando-foo-${service}`);
  });

  test.each(["web_1", "a.b", "x".repeat(60), `${"a".repeat(43)}-${"b".repeat(20)}`])(
    "hashes the container name when service %s does not fit one DNS label",
    (service) => {
      // When
      const actual = hostname(service);
      // Then
      expect(actual).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
      expect(actual.startsWith(`${nameHash(service)}-lando-foo-`)).toBe(true);
    },
  );

  test.each([
    ["web_1", "web-1"],
    ["a.b", "a-b"],
    ["web_1", `web-1-${nameHash("web_1")}`],
    [`${"x".repeat(60)}-alpha`, `${"x".repeat(60)}-beta`],
  ])("keeps services %s and %s apart", (left, right) => {
    expect(hostname(left)).not.toBe(hostname(right));
  });
});
