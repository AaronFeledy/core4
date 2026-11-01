import { expect, test } from "bun:test";
import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator } from "./fixtures/test-ports.ts";

const translate = (text: string) =>
  Effect.runPromise(makeTestTranslator().translate(documentSet([document(".lando.yml", text)])));

test.each(["postgres:15", "postgres:17", "postgres:18", "node:24", "node:26"])(
  "accepts the injected catalog version %s",
  async (type) => {
    // Given / When
    const result = await translate(`services: {server: {type: "${type}"}}`);
    // Then
    expect(result.outputs[0]?.fragment).toHaveProperty("services.server.type", type);
    expect(result.diagnostics).toEqual([]);
  },
);

test.each([
  ["mysql:8.0", "MYSQL_TCP_PORT", 3307],
  ["mariadb:11.4", "MYSQL_TCP_PORT", 3307],
  ["postgres:17", "PGPORT", 5433],
  ["mssql:2022", "MSSQL_TCP_PORT", 1435],
  ["rabbitmq", "RABBITMQ_NODE_PORT", 5673],
  ["phpmyadmin:5", "APACHE_PORT", 8081],
  ["node:22", "PORT", 8081],
  ["python:3.12", "PORT", 8081],
  ["ruby:3.3", "PORT", 8081],
  ["go:1.22", "PORT", 8081],
  ["dotnet:8.0", "ASPNETCORE_HTTP_PORTS", 8081],
  ["elasticsearch:8", "http.port", 9201],
  ["opensearch:2", "http.port", 9201],
] as const)("moves the native listener variable for %s", async (type, variable, port) => {
  // Given
  const text = `services: {server: {type: ${type}, environment: {${variable}: "${port}"}}}`;
  // When
  const result = await translate(text);
  // Then
  const fragment = Schema.decodeUnknownSync(LandofileAuthoringFragment, { onExcessProperty: "error" })(
    result.outputs[0]?.fragment,
  );
  expect(fragment).toHaveProperty("services.server", { type, port });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      kind: "needs-review",
      keyPath: ["services", "server", "environment", variable],
    }),
  ]);
});

test.each([
  { fields: "environment: {PGPORT: 5433}", path: ["environment", "PGPORT"], retained: {} },
  { fields: 'environment: ["PGPORT=5432", "PGPORT=5433"]', path: ["environment", 1], retained: {} },
  {
    fields: "environment: {PGPORT: 5432, KEEP: yes}, overrides: {environment: {PGPORT: 5433}}",
    path: ["overrides", "environment", "PGPORT"],
    retained: { environment: { KEEP: "yes" } },
  },
  {
    fields:
      'environment: {PGPORT: 5432, KEEP: yes}, overrides: {environment: ["PGPORT=5434", "PGPORT=5433"]}',
    path: ["overrides", "environment", 1],
    retained: { environment: { KEEP: "yes" } },
  },
  { fields: "port: 5433, environment: {PGPORT: 5433}", path: ["environment", "PGPORT"], retained: {} },
])("uses the winning literal assignment when $fields", async ({ fields, path, retained }) => {
  // Given
  const text = `services: {db: {type: postgres:17, ${fields}}}`;
  // When
  const result = await translate(text);
  // Then
  const fragment = Schema.decodeUnknownSync(LandofileAuthoringFragment, { onExcessProperty: "error" })(
    result.outputs[0]?.fragment,
  );
  expect(fragment).toHaveProperty("services.db", { type: "postgres:17", port: 5433, ...retained });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ kind: "needs-review", keyPath: ["services", "db", ...path] }),
  ]);
});

test.each([1, 65535])("accepts TCP listener boundary %s without planner validation", async (port) => {
  // Given
  const text = `services: {db: {type: postgres:17, environment: {PGPORT: "${port}"}}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.db", { type: "postgres:17", port });
  expect(result.diagnostics).toMatchObject([
    { kind: "needs-review", keyPath: ["services", "db", "environment", "PGPORT"] },
  ]);
});

test.each(["nope", "0", "65536", "5433.0", "+5433", " 5433", "${X}", "{{ env.PORT }}"])(
  "keeps an unresolved listener assignment %s for manual repair",
  async (value) => {
    // Given
    const text = `services: {db: {type: postgres:17, environment: {PGPORT: ${JSON.stringify(value)}}}}`;
    // When
    const result = await translate(text);
    // Then
    expect(result.outputs[0]?.fragment).toMatchObject({
      services: { db: { environment: { PGPORT: value } } },
    });
    expect(result.outputs[0]?.fragment).not.toHaveProperty("services.db.port");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "unsupported", keyPath: ["services", "db", "environment", "PGPORT"] }),
    ]);
  },
);

test.each([
  { fields: "environment: {PGPORT: 5433}", path: ["environment", "PGPORT"] },
  { fields: "overrides: {environment: {PGPORT: 5433}}", path: ["overrides", "environment", "PGPORT"] },
])("retains conflicting listener intent when $fields", async ({ fields, path }) => {
  // Given
  const text = `services: {db: {type: postgres:17, port: 5434, ${fields}}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toMatchObject({
    services: { db: { port: 5434, environment: { PGPORT: "5433" } } },
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ kind: "unsupported", keyPath: ["services", "db", ...path] }),
  ]);
});

test.each([
  ["environment: {PGPORT: 5433}", "5433"],
  ['environment: {PGPORT: 5432}, overrides: {environment: ["PGPORT=5434", "PGPORT=5433"]}', "5433"],
  ["port: 5434", "5434"],
  ["port: 5434, environment: {PGPORT: 5433}", "5434"],
  ['environment: {PGPORT: "${X}"}', "5432"],
  ["", "5432"],
] as const)("publishes the planned listener when %s", async (fields, published) => {
  // Given
  const text = `services: {db: {type: postgres, portforward: true${fields ? `, ${fields}` : ""}}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.db.ports", [published]);
});

test.each([["apache", "APACHE_PORT"]] as const)(
  "leaves unrelated environment intent on %s",
  async (type, variable) => {
    // Given
    const text = `services: {web: {type: "${type}", environment: {${variable}: 8081}}}`;
    // When
    const result = await translate(text);
    // Then
    expect(result.outputs[0]?.fragment).toMatchObject({
      services: { web: { type, environment: { [variable]: "8081" } } },
    });
    expect(result.outputs[0]?.fragment).not.toHaveProperty("services.web.port");
    expect(result.diagnostics).toEqual([]);
  },
);

test("publishes the base listener when portforward is authored only in the local layer", async () => {
  // Given
  const translator = makeTestTranslator();
  const input = documentSet([
    document(".lando.yml", "services: {db: {type: postgres, environment: {PGPORT: 5433}}}"),
    { ...document(".lando.local.yml", "services: {db: {portforward: true}}"), layerId: "local" },
  ]);
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(result.outputs).toHaveLength(2);
  for (const output of result.outputs) {
    const fragment = Schema.decodeUnknownSync(LandofileAuthoringFragment, { onExcessProperty: "error" })(
      output.fragment,
    );
    expect(fragment).not.toHaveProperty("services.db.environment");
  }
  expect(result.outputs[0]?.fragment).toHaveProperty("services.db.port", 5433);
  expect(result.outputs[1]?.fragment).toHaveProperty("services.db.ports", ["5433"]);
});
