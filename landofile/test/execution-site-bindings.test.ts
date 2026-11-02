import { expect, test } from "bun:test";
import { executionSiteAt } from "@lando/sdk/landofile";
import { SECRET_BINDING_SITES, eligibleBindingPath } from "../src/secret-reference.ts";

const patterns = SECRET_BINDING_SITES.flatMap((site) => site.paths);
test.each(patterns)("schema and fast binding predicate agree on %s", (pattern) => {
  const path = pattern.split(".").map((segment) => {
    if (segment === "<index>") return 0;
    return /^<.*>$/.test(segment) ? "TOKEN" : segment;
  });
  expect(eligibleBindingPath(path)).toBe(true);
  expect(executionSiteAt(path)?.site).toBe("secret-binding");
});

test.each([
  [["services", "app", "environment", 0]],
  [["tooling", "deploy", "env", 0]],
  [["toolingDefaults", "env", 0]],
  [["events", "post-start", 0, "env", 0]],
])("schema and fast binding predicate agree on list bindings %j", (path) => {
  expect(eligibleBindingPath(path)).toBe(true);
  expect(executionSiteAt(path)?.site).toBe("secret-binding");
});

test.each([
  [["services", "app", "command"]],
  [["services", "app", "build", "args", "TOKEN"]],
  [["tooling", "deploy", "cmd"]],
  [["events", "post-start", 0, "cmd"]],
  [["toolingDefaults", "vars", "token", "sh"]],
  [["name"]],
])("schema and fast binding predicate reject non-binding paths %j", (path) => {
  expect(eligibleBindingPath(path)).toBe(false);
  expect(executionSiteAt(path)?.site).not.toBe("secret-binding");
});
