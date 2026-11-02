import { expect, test } from "bun:test";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { HOST_EVENT_NAMES } from "@lando/sdk/schema";
import { compileEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import { reservedEventCollisions, validEventNames } from "../../src/planner/event-names.ts";

const staticNames = [
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
  "pre-destroy",
  "post-destroy",
  "post-pull",
  "post-push",
  "post-switch",
  "post-code-sync",
];

test("hostEvents covers the ten start/stop/restart/rebuild/destroy brackets", () => {
  expect([...HOST_EVENT_NAMES]).toEqual([
    "pre-start",
    "post-start",
    "pre-stop",
    "post-stop",
    "pre-restart",
    "post-restart",
    "pre-rebuild",
    "post-rebuild",
    "pre-destroy",
    "post-destroy",
  ]);
  for (const name of HOST_EVENT_NAMES) expect(staticNames).toContain(name);
});

test("enumerates lifecycle names and remote sync hooks when tooling is empty", () => {
  // Given / When
  const valid = validEventNames({});
  // Then
  expect(valid).toEqual(staticNames);
});

test("includes authored, contributed, namespaced and disabled tasks but excludes internal tasks", () => {
  // Given
  const landofile = rememberInternalToolingTasks(
    {
      tooling: {
        "docs:build": { cmd: "build" },
        hidden: { cmd: "hidden" },
        disabled: { cmd: "disabled", disabled: true },
        mysql: { cmd: "authored" },
      },
    },
    ["hidden"],
  );
  const tooling = compileEffectiveTooling({
    landofile,
    services: [{ name: "db", tooling: { mysql: { cmd: "mysql" }, sql: { cmd: "sql" } } }],
  });
  // When
  const valid = validEventNames(tooling);
  // Then
  expect(valid).toEqual([
    ...staticNames,
    "post-disabled",
    "post-docs:build",
    "post-mysql",
    "post-sql",
    "pre-disabled",
    "pre-docs:build",
    "pre-mysql",
    "pre-sql",
  ]);
  expect(
    validEventNames(
      rememberInternalToolingTasks(Object.fromEntries(Object.entries(tooling).reverse()), ["hidden"]),
    ),
  ).toEqual(valid);
});

test("omits brackets for reserved tooling names", () => {
  // Given
  const tooling = {
    prepare: { cmd: "ready" },
    run: { cmd: "run" },
    scratch: { cmd: "scratch" },
    "scratch:gc": { cmd: "gc" },
  };
  // When
  const valid = validEventNames(tooling);
  // Then
  expect(valid).toEqual([...staticNames, "post-prepare", "pre-prepare"]);
});

test("reports the reserved events a tooling task's brackets would bind", () => {
  // Given / When / Then
  expect(reservedEventCollisions("start")).toEqual(["pre-start", "post-start"]);
  expect(reservedEventCollisions("pull")).toEqual(["post-pull"]);
  expect(reservedEventCollisions("code-sync")).toEqual(["post-code-sync"]);
  expect(reservedEventCollisions("build")).toEqual([]);
});
