import { describe, expect, test } from "bun:test";
import { parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";

describe.each(["/team", "/team/nested"])("registry base %s", (path) => {
  describe.each([
    { name: "Bearer", fields: ["_authToken=child-token"], expected: "Bearer child-token" },
    { name: "Basic auth", fields: ["_auth=YWxpY2U6c2VjcmV0"], expected: "Basic YWxpY2U6c2VjcmV0" },
    {
      name: "Basic pair",
      fields: ["username=alice", "_password=c2VjcmV0"],
      expected: "Basic YWxpY2U6c2VjcmV0",
    },
    {
      name: "same-key Bearer precedence",
      fields: ["_auth=YWxpY2U6c2VjcmV0", "_authToken=child-token"],
      expected: "Bearer child-token",
    },
  ])("$name", ({ fields, expected }) => {
    const child = fields.map((field) => `//npm.test${path}/:${field}`).join("\n");
    const parent = `//npm.test${path.slice(0, path.lastIndexOf("/"))}/:_authToken=parent-token`;

    test.each(["", "/"])("finds base credentials without a parent when suffix is '%s'", (suffix) => {
      const config = parseNpmRegistryConfig(child);
      const registry = `https://npm.test${path}${suffix}`;

      const credential = config.credentialFor(registry, registry);

      expect(credential?.authorization).toBe(expected);
    });

    test.each(["", "/"])("prefers base credentials over a parent when suffix is '%s'", (suffix) => {
      const config = parseNpmRegistryConfig(`${parent}\n${child}`);
      const registry = `https://npm.test${path}${suffix}`;

      const authorization = config.authorizationFor(registry, registry);

      expect(authorization).toBe(expected);
    });

    test("uses the slashless registry fallback for a same-host tarball outside its prefix", () => {
      // A nested parent competes only in the fallback walk, not in the resource walk.
      const config = parseNpmRegistryConfig(path === "/team/nested" ? `${parent}\n${child}` : child);

      const authorization = config.authorizationFor(
        "https://npm.test/download/pkg.tgz",
        `https://npm.test${path}`,
      );

      expect(authorization).toBe(expected);
    });

    test("preserves folder credentials for metadata under a slashless registry", () => {
      const config = parseNpmRegistryConfig(`${parent}\n${child}`);

      const authorization = config.authorizationFor(
        `https://npm.test${path}/@acme%2fpkg`,
        `https://npm.test${path}`,
      );

      expect(authorization).toBe(expected);
    });

    test("suppresses credentials for cross-host resources with a slashless registry", () => {
      const config = parseNpmRegistryConfig(`${parent}\n${child}\n//other.test/:_authToken=other-token`);

      const authorization = config.authorizationFor("https://other.test/pkg.tgz", `https://npm.test${path}`);

      expect(authorization).toBeUndefined();
    });
  });
});

test("does not turn a metadata resource into a folder when selecting its credentials", () => {
  const config = parseNpmRegistryConfig(
    [
      "//npm.test/:_authToken=root-token",
      "//npm.test/team/:_authToken=team-token",
      "//npm.test/team/pkg:_authToken=resource-token",
      "//npm.test/team/pkg/:_authToken=folder-token",
    ].join("\n"),
  );

  const authorization = config.authorizationFor("https://npm.test/team/pkg", "https://npm.test/team");

  expect(authorization).toBe("Bearer resource-token");
});

test("keeps request-path credentials ahead of the selected registry fallback", () => {
  const config = parseNpmRegistryConfig(
    "//npm.test/:_authToken=root-token\n//npm.test/team/:_authToken=team-token",
  );

  const authorization = config.authorizationFor("https://npm.test/download/pkg.tgz", "https://npm.test/team");

  expect(authorization).toBe("Bearer root-token");
});
