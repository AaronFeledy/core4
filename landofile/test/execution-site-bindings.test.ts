import { expect, test } from "bun:test";
import { executionSiteAt } from "@lando/sdk/landofile/execution-sites";
import { SECRET_BINDING_SITES, eligibleBindingPath } from "../src/secret-reference.ts";

const examplePath = (pattern: string): Array<string | number> =>
  pattern.split(".").map((segment) => {
    if (segment === "<index>") return 0;
    return /^<.*>$/.test(segment) ? "TOKEN" : segment;
  });

test.each(SECRET_BINDING_SITES.flatMap((site) => site.paths))(
  "the fast binding predicate accepts %s",
  (pattern) => {
    expect(eligibleBindingPath(examplePath(pattern))).toBe(true);
  },
);

test.each([
  [["services", "app", "environment", 0]],
  [["tooling", "deploy", "env", 0]],
  [["toolingDefaults", "env", 0]],
  [["events", "post-start", 0, "env", 0]],
])("the fast binding predicate accepts list bindings %j", (path) => {
  expect(eligibleBindingPath(path)).toBe(true);
});

test.each([
  [["services", "web", "environment", "TOKEN"]],
  [["services", "web", "creds", "password"]],
  [["services", "web", "creds", "rootPassword"]],
  [["services", "web", "password"]],
  [["tooling", "deploy", "env", "TOKEN"]],
  [["tooling", "deploy", "cmds", 0, "env", "TOKEN"]],
  [["tooling", "deploy", "vars", "token", "env", "TOKEN"]],
  [["toolingDefaults", "env", "TOKEN"]],
  [["events", "post-start", 0, "env", "TOKEN"]],
])("secret-binding values carry no execution site of their own: %j", (path) => {
  // Binding permission comes only from eligibleBindingPath. The enclosing tooling
  // `cmds` array is the one execution site an env value can inherit.
  const match = executionSiteAt(path);
  if (path[0] === "tooling" && path[2] === "cmds") {
    expect(match).toEqual({ site: "tooling-cmds", relativePath: [0, "env", "TOKEN"] });
    return;
  }
  expect(match).toBeUndefined();
});

test.each([
  [["services", "app", "command"], "service-command"],
  [["services", "app", "entrypoint"], "service-entrypoint"],
  [["services", "app", "healthcheck"], "healthcheck"],
  [["tooling", "deploy", "cmd"], "tooling-cmd"],
  [["tooling", "deploy", "cmds", 0], "tooling-cmds"],
  [["tooling", "deploy", "vars", "token", "sh"], "tooling-var"],
  [["events", "post-start", 0], "event-step"],
  [["events", "post-start", 0, "cmd"], "event-step"],
  [["events", "post-start", 0, "defer"], "event-step"],
] as const)("command sites classify without granting binding permission: %j", (path, site) => {
  expect(eligibleBindingPath(path)).toBe(false);
  expect(executionSiteAt(path)?.site).toBe(site);
});
