import { expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { type AppConfigViewOptions, appConfigView } from "../../src/operations/app-config-view.ts";

const inspect = (landofile: LandofileShape, options: AppConfigViewOptions) =>
  appConfigView(options).pipe(
    Effect.provideService(LandofileService, LandofileService.of({ discover: Effect.succeed(landofile) })),
  );

for (const options of [{ subcommand: "get", key: "services.web" }, { path: "services.web" }] as const) {
  test(`returns canonical dependencies when resolved selection uses ${"key" in options ? "get" : "path"}`, async () => {
    // Given an authored Compose dependency map decoded by the real schema.
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "inspection",
      services: {
        web: {
          type: "node:lts",
          dependsOn: { database: { condition: "service_healthy", restart: true } },
          environment: { PASSWORD: "selection-canary" },
        },
        database: { type: "postgres" },
      },
    });

    // When the decoded service is selected.
    const result = await Effect.runPromise(inspect(landofile, options));

    // Then selection stays canonical and retains its metadata.
    expect(result).toMatchObject({
      source: "resolved",
      ...options,
      app: "inspection",
      sources: [],
      redactionTokens: ["selection-canary"],
      value: {
        dependsOn: [{ service: "database", condition: "service_healthy", restart: true }],
      },
    });
  });
}

test("returns literal-envelope-shaped extension data verbatim when selected", async () => {
  // Given ordinary user data that resembles an authored directive envelope.
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "inspection",
    "x-literal": { _tag: "LandofileReset" },
  });

  // When the extension is selected from resolved configuration.
  const result = await Effect.runPromise(inspect(landofile, { subcommand: "get", key: "x-literal" }));

  // Then no authored literal escaping is applied.
  expect(result).toMatchObject({ value: { _tag: "LandofileReset" } });
});

test("fails with ConfigError instead of a defect when selected extension data is non-JSON", async () => {
  // Given a decoded extension containing a function from a programmatic source.
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "inspection",
    "x-function": () => "unsupported",
  });

  // When the unsupported value reaches the inspection boundary.
  const result = await Effect.runPromise(inspect(landofile, { path: "x-function" }).pipe(Effect.result));

  // Then it is a typed failure; defects would reject runPromise instead.
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ConfigError" } });
});

test("preserves null when the selected extension is explicitly null", async () => {
  // Given a present null extension.
  const landofile = Schema.decodeUnknownSync(LandofileShape)({ name: "inspection", "x-null": null });

  // When that extension is selected.
  const result = await Effect.runPromise(inspect(landofile, { path: "x-null" }));

  // Then null remains a present value.
  expect(result).toMatchObject({ path: "x-null", value: null });
});

test("omits value when the selected extension is missing", async () => {
  // Given a decoded Landofile without the requested extension.
  const landofile = Schema.decodeUnknownSync(LandofileShape)({ name: "inspection" });

  // When the absent extension is selected.
  const result = await Effect.runPromise(inspect(landofile, { subcommand: "get", key: "x-missing" }));

  // Then the selector survives without manufacturing a value.
  expect(result).toMatchObject({ subcommand: "get", key: "x-missing" });
  expect(Object.hasOwn(result, "value")).toBe(false);
});
