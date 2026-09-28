import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { lando3ConfigTranslator } from "../src/translator.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";

const shapes = [
  { type: "compose", path: "services" },
  { type: "lando", path: "services" },
  { type: "node:22", path: "overrides" },
  { type: "lando", api: 4, path: "overrides" },
] as const;

test("splits scalar Compose fields when an API-4 l337 service passes them through", async () => {
  // Given
  const input = documentSet([
    document(
      ".lando.yml",
      JSON.stringify({
        services: {
          app: { api: 4, type: "l337", image: "alpine", command: "--port 8080", entrypoint: "sh -c" },
        },
      }),
    ),
  ]);
  // When
  const result = await Effect.runPromise(lando3ConfigTranslator.translate(input));
  // Then
  expect(result.outputs[0]?.fragment).toMatchObject({
    services: { app: { command: ["--port", "8080"], entrypoint: ["sh", "-c"] } },
  });
});

test("preserves a shell script when the catalog owns the top-level command", async () => {
  // Given
  const input = documentSet([
    document(
      ".lando.yml",
      JSON.stringify({
        services: { app: { type: "node:22", command: "echo a && echo b" } },
      }),
    ),
  ]);
  // When
  const result = await Effect.runPromise(lando3ConfigTranslator.translate(input));
  // Then
  expect(result.outputs[0]?.fragment).toMatchObject({
    services: { app: { command: "echo a && echo b" } },
  });
});

for (const shape of shapes) {
  describe(`${shape.type} ${"api" in shape ? shape.api : 3} ${shape.path}`, () => {
    for (const key of ["command", "entrypoint"] as const) {
      test.each([
        ["--port 8080", ["--port", "8080"]],
        ['sh -c "echo a b"', ["sh", "-c", "echo a b"]],
        [
          ["--port", "8080", "a b"],
          ["--port", "8080", "a b"],
        ],
      ])(`preserves argv when ${key} is %j`, async (value, expected) => {
        // Given
        const { path, ...service } = shape;
        const input = documentSet([
          document(
            ".lando.yml",
            JSON.stringify({
              services: { app: { ...service, [path]: { image: "traefik/whoami", [key]: value } } },
            }),
          ),
        ]);
        // When
        const result = await Effect.runPromise(lando3ConfigTranslator.translate(input));
        // Then
        expect(result.outputs[0]?.fragment).toMatchObject({ services: { app: { [key]: expected } } });
        expect(result.diagnostics.filter((diagnostic) => diagnostic.keyPath.at(-1) === key)).toEqual(
          typeof value === "string"
            ? [expect.objectContaining({ kind: "rewritten", keyPath: ["services", "app", path, key] })]
            : [],
        );
      });

      test(`blocks the service when ${key} has unmatched quotes`, async () => {
        // Given
        const { path, ...service } = shape;
        const input = documentSet([
          document(
            ".lando.yml",
            JSON.stringify({
              services: { app: { ...service, [path]: { image: "traefik/whoami", [key]: '"secret-value' } } },
            }),
          ),
        ]);
        // When
        const result = await Effect.runPromise(lando3ConfigTranslator.translate(input));
        // Then
        expect(result.outputs).toEqual([]);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            kind: "unsupported",
            sourceId: ".lando.yml",
            keyPath: ["services", "app", path, key],
          }),
        );
        expect(JSON.stringify(result.diagnostics)).not.toContain("secret-value");
      });
    }
  });
}
