import { expect, test } from "bun:test";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { compileEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import { unknownEventError, unknownEventName, validEventNames } from "../../src/planner/event-names.ts";

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
];

test("enumerates canonical lifecycle names when tooling is empty", () => {
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

test("returns the first authored unknown key when some names are invalid", () => {
  // Given
  const events = { "pre-start": [], "pre-absent": [], "post-absent": [] };
  // When
  const unknown = unknownEventName(events, validEventNames({}));
  // Then
  expect(unknown).toBe("pre-absent");
  expect(unknownEventName(undefined, staticNames)).toBeUndefined();
});

test("reports the complete contextual set when an event is unknown", () => {
  // Given
  const valid = validEventNames({ prepare: { cmd: "ready" } });
  // When
  const error = unknownEventError("pre-missing", valid, "/app/.lando.ts");
  // Then
  expect(error.validEvents).toEqual([...staticNames, "post-prepare", "pre-prepare"]);
  expect(error.file).toBe("/app/.lando.ts");
  for (const name of [...staticNames, "post-prepare", "pre-prepare"]) {
    expect(error.message).toContain(name);
    expect(error.remediation).toContain(name);
  }
});
