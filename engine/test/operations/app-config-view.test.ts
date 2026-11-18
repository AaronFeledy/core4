import { expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { type AppConfigViewOptions, appConfigView } from "../../src/operations/app-config-view.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const inspect = (landofile: LandofileShape, options: AppConfigViewOptions) =>
  appConfigView(options).pipe(
    Effect.provideService(
      LandofileService,
      LandofileService.of({ discover: Effect.succeed(literalTestLandofile(landofile)) }),
    ),
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
        // Resolved selection reads the encoded Landofile tree so map forms match full JSON/YAML.
        dependsOn: { database: { condition: "service_healthy", restart: true } },
        type: "node:lts",
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

test("selects encoded endpoint kind from the resolved Landofile tree", async () => {
  // Given a decoded Landofile whose wire spelling uses kind.
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "inspection",
    services: {
      web: {
        type: "compose",
        image: "nginx:alpine",
        endpoints: ["ui=http:8080", { kind: "internal", protocol: "tcp", port: 9000 }],
      },
    },
  });

  // When a parent endpoint and a kind field are selected.
  const parent = await Effect.runPromise(inspect(landofile, { path: "services.web.endpoints[0]" }));
  const kind = await Effect.runPromise(inspect(landofile, { path: "services.web.endpoints[0].kind" }));

  // Then selection agrees with the full encoded document and never exposes _tag.
  expect(parent).toMatchObject({
    path: "services.web.endpoints[0]",
    value: { kind: "internal", protocol: "http", port: 8080, name: "ui" },
  });
  expect(kind).toMatchObject({ path: "services.web.endpoints[0].kind", value: "internal" });
  expect(JSON.stringify(parent)).not.toContain('"_tag"');
  expect(JSON.stringify(kind)).not.toContain('"_tag"');
});
