import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { PLAN_IDENTITY_EXPRESSION_SCOPES, materializeExpressionScopes } from "../src/recipe-expressions.ts";
import { loadLandofileFile } from "../src/service.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-file-literals-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  "load('./payload.json')",
  "load('./payload.yml')",
  "import('./payload.json').value",
  "import('./payload.yml').value",
])("escapes nested plain data produced by %s in the loaded document", async (expression) => {
  // Given
  const value = { nested: { values: ["{{ app.name }} ${VALUE}", "${ONLY}"] } };
  await writeFile(join(root, "payload.json"), JSON.stringify(value));
  await writeFile(
    join(root, "payload.yml"),
    'nested:\n  values:\n    - "{{ app.name }} ${VALUE}"\n    - "${ONLY}"\n',
  );
  const file = join(root, ".lando.yml");
  await writeFile(file, `name: literal\nx-produced: "{{ ${expression} }}"\n`);
  // When
  const loaded = await Effect.runPromise(loadLandofileFile(file));
  // Then
  expect(loaded["x-produced"]).toEqual({ nested: { values: ["{{{{ app.name }} $${VALUE}", "${ONLY}"] } });
});

test("escapes a plain text file-helper result at a string site", async () => {
  // Given
  await writeFile(join(root, "payload.txt"), "{{ app.name }}");
  const file = join(root, ".lando.yml");
  await writeFile(
    file,
    "name: literal\nservices:\n  web:\n    environment:\n      FOO: \"{{ load('./payload.txt') }}\"\n",
  );
  // When
  const loaded = await Effect.runPromise(loadLandofileFile(file));
  // Then
  expect(loaded.services?.[ServiceName.make("web")]?.environment?.FOO).toBe("{{{{ app.name }}");
});

test.each(["{{ app.name }}", "{{ env.QA_UNSET }}"])(
  "preserves opaque security ImportRef contents %s and reference metadata",
  async (content) => {
    // Given
    const basename = "ca{{ opaque }}.pem";
    await writeFile(join(root, basename), content);
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      `name: literal\nservices:\n  web:\n    security:\n      ca:\n        - "{{ import('./${basename}') }}"\n`,
    );
    // When
    const loaded = await Effect.runPromise(loadLandofileFile(file));
    const materialized = materializeExpressionScopes(loaded, file, {
      context: { app: { name: "not-the-file-content" }, env: {} },
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
      textOnly: true,
    });
    // Then
    expect(loaded.services?.[ServiceName.make("web")]?.security?.ca).toMatchObject([
      { _tag: "ImportRef", path: `./${basename}`, basename, value: content },
    ]);
    expect(materialized.value.services?.[ServiceName.make("web")]?.security?.ca).toEqual(
      loaded.services?.[ServiceName.make("web")]?.security?.ca,
    );
  },
);

test("preserves file-reference metadata nested in a produced object", async () => {
  // Given
  const basename = "data{{ opaque }}.txt";
  await writeFile(join(root, basename), "data");
  const file = join(root, ".lando.yml");
  await writeFile(file, `name: literal\nx-produced: "{{ { ref: load('./${basename}') } }}"\n`);
  // When
  const loaded = await Effect.runPromise(loadLandofileFile(file));
  // Then
  expect(loaded["x-produced"]).toMatchObject({ ref: { _tag: "FileRef", path: join(root, basename) } });
});
