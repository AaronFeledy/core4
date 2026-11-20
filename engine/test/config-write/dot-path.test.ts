import { expect, test } from "bun:test";
import { Result } from "effect";
import { getAtPath, parsePathSegments, setAtPath, unsetAtPath } from "../../src/config-write/dot-path.ts";
import { resolveConfigPath } from "../../src/config-write/write-core.ts";

test.each([
  ["services.web.type", ["services", "web", "type"]],
  ["tooling.test.cmds[0]", ["tooling", "test", "cmds", 0]],
  ["tooling.2fa.cmd", ["tooling", "2fa", "cmd"]],
  ["settings.key with spaces", ["settings", "key with spaces"]],
  ["tooling.ns:task", ["tooling", "ns:task"]],
  ["tooling.a/b", ["tooling", "a/b"]],
  ["tooling.@scope/pkg", ["tooling", "@scope/pkg"]],
  ["environment.APP_ENV", ["environment", "APP_ENV"]],
  ["[0]", [0]],
  ["list.[01]", ["list", 1]],
] as const)("preserves the bare selector %s", (selector, expected) => {
  expect(parsePathSegments(selector)).toEqual([...expected]);
});

test.each([
  ['map["0"]', "key"],
  ["map.0", "key"],
  ["map[0]", undefined],
  ["list[0]", "index"],
  ["list.0", "index"],
  ["list.00", undefined],
  ["list.9007199254740992", undefined],
  ['list["0"]', undefined],
])("reads numeric segment %s according to its spelling and container", (selector, expected) => {
  expect(getAtPath({ map: { "0": "key" }, list: ["index"] }, selector)).toBe(expected);
});

test("a bare numeric segment edits an existing list item on set and unset", () => {
  const tree = { tooling: { test: { cmds: ["first", "second"] } } };
  expect(setAtPath(tree, "tooling.test.cmds.0", "changed")).toEqual({
    tooling: { test: { cmds: ["changed", "second"] } },
  });
  expect(unsetAtPath(tree, "tooling.test.cmds.0")).toEqual({
    next: { tooling: { test: { cmds: ["second"] } } },
    changed: true,
  });
});

test.each([
  ['tooling.test.cmds["0"]', "`tooling.test.cmds` is a list"],
  ["tooling.test.cmds.first", "`tooling.test.cmds` is a list"],
])("refuses %s instead of reshaping the list", (selector, message) => {
  const tree = { tooling: { test: { cmds: ["first", "second"] } } };
  const resolved = resolveConfigPath(tree, selector, "/app/.lando.yml");
  expect(Result.isFailure(resolved) && resolved.failure.message).toContain(message);
  expect(Result.isSuccess(resolveConfigPath(tree, "tooling.test.cmds[1]", "/app/.lando.yml"))).toBe(true);
});
