import { expect, test } from "bun:test";
import { override, reset, valueOriginAt } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { checkDocumentData } from "../../src/pipeline/data.ts";
import { prepareOverlay } from "../../src/pipeline/prepare.ts";

test("preparation preserves authored forms and original alias origins inside overrides", async () => {
  const input = {
    services: {
      web: override({
        working_dir: "/site",
        appMount: "/site",
        primary: "{{ recipe.flag }}",
        env_file: ["local.env"],
      }),
    },
  };
  const result = await Effect.runPromise(
    prepareOverlay(input, { file: "/app/.lando.local.yml", layer: "local" }),
  );
  expect(result.value).toEqual({
    services: {
      web: override({
        workingDirectory: "/site",
        appMount: "/site",
        primary: "{{ recipe.flag }}",
        envFile: ["local.env"],
      }),
    },
  });
  expect(valueOriginAt(result.origins, ["services", "web", "envFile"]).source).toEqual({
    file: "/app/.lando.local.yml",
    layer: "local",
    path: ["services", "web", "env_file"],
  });
  expect(input.services.web.value).toHaveProperty("working_dir", "/site");
});

test("preparation rejects a native operation that changes keyed identity", async () => {
  const error = await Effect.runPromise(
    prepareOverlay(
      { services: { web: { routes: [{ hostname: reset() }] } } },
      { file: "/app/.lando.yml", layer: "canonical" },
    ).pipe(Effect.flip),
  );
  expect(error.issues[0]?.source?.path).toEqual(["services", "web", "routes", 0, "hostname"]);
});

test("file-helper generated children inherit their authored expression site", async () => {
  const result = await Effect.runPromise(
    prepareOverlay(
      { services: { web: { environment: { GENERATED: { nested: true } } } } },
      { file: "/app/.lando.local.yml", layer: "local" },
      { services: { web: { environment: "{{ load('./environment.json') }}" } } },
    ),
  );
  expect(
    valueOriginAt(result.origins, ["services", "web", "environment", "GENERATED", "nested"]).source,
  ).toEqual({ file: "/app/.lando.local.yml", layer: "local", path: ["services", "web", "environment"] });
});

test("data preparation bounds cyclic programmatic exports before expression traversal", async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const error = await Effect.runPromise(
    checkDocumentData(cycle, { file: "/app/.lando.ts", layer: "canonical" }).pipe(Effect.flip),
  );
  expect(error._tag).toBe("LandofileValidationError");
  expect(error.issues[0]?.source).toMatchObject({ file: "/app/.lando.ts", layer: "canonical" });
});
