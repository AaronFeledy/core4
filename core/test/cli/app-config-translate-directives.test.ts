import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { encodeTranslateOutputs } from "../../src/cli/commands/app-config-translate-encode.ts";

test.each([
  { services: { web: { routes: [{ hostname: { _tag: "LandofileOverride", value: "web.test" } }] } } },
  { services: { db: { creds: { user: "only-user" } } } },
])("translation rejects independently invalid native layers %j", async (fragment) => {
  const encoded: unknown[] = [];
  const result = await Effect.runPromise(
    Effect.result(
      encodeTranslateOutputs(
        { appRoot: "/tmp/translation-directives", inputPath: "/tmp/translation-directives/.lando.yml" },
        {
          outputs: [
            { targetLayer: "dist", sourceIds: [], fragment },
            {
              targetLayer: "canonical",
              sourceIds: [],
              fragment: {
                name: "valid-final",
                services: {
                  web: { routes: ["web.test"] },
                  db: { creds: { user: "user", password: "password", database: "database" } },
                },
              },
            },
          ],
          currentLowerV4Fragments: [],
        },
        (input) => {
          encoded.push(input);
          return Effect.succeed({ text: "", diagnostics: [] });
        },
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(encoded).toEqual([]);
});
