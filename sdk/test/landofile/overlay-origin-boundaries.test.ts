import { expect, test } from "bun:test";
import {
  mergeValuesWithOrigins,
  override,
  reset,
  valueOriginAt,
  withValueOrigins,
} from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";

const layer = (value: unknown, file: string) => withValueOrigins(value, (path) => ({ file, path }));

test.each([
  ["single var", { vars: { DROP: reset() } }, { cmd: "included", vars: { KEEP: "include" } }],
  ["whole vars", { vars: reset() }, { cmd: "included" }],
  ["vars override", { vars: override({ OWN: "local" }) }, { cmd: "included", vars: { OWN: "local" } }],
  ["task override", override({ cmd: "local" }), { cmd: "local" }],
])("retains consumed %s boundaries when a projected overlay is composed again", (_case, task, expected) => {
  const lower = layer(
    { tooling: { task: { cmd: "included", vars: { KEEP: "include", DROP: "include" } } } },
    "include.yml",
  );
  const projected = mergeValuesWithOrigins(
    LandofileShape,
    layer({}, "empty"),
    layer({ tooling: { task } }, "local.yml"),
  );
  const result = mergeValuesWithOrigins(LandofileShape, lower, projected);
  expect(result.value).toEqual({ tooling: { task: expected } });
  expect(valueOriginAt(result.origins, ["tooling", "task"]).source.file).toBe("local.yml");
});

test("retains a task form replacement through a later object merge", () => {
  const scalar = layer({ tooling: { task: "echo scalar" } }, "base.yml");
  const object = layer({ tooling: { task: { cmd: "echo object" } } }, "local.yml");
  const projected = mergeValuesWithOrigins(LandofileShape, scalar, object);
  const higher = mergeValuesWithOrigins(
    LandofileShape,
    projected,
    layer({ tooling: { task: { description: "user" } } }, "user.yml"),
  );
  const result = mergeValuesWithOrigins(
    LandofileShape,
    layer({ tooling: { task: { vars: { OLD: "include" } } } }, "include.yml"),
    higher,
  );
  expect(result.value).toEqual({ tooling: { task: { cmd: "echo object", description: "user" } } });
  expect(valueOriginAt(result.origins, ["tooling", "task"]).replaced).toBe(true);
});
