import { expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { isPlainRecord, mergeLandofiles } from "../src/v4-merge.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

const translate = (text: string) => {
  const fake = fakeDecomposers();
  const translator = makeLando3ConfigTranslator({
    decomposers: fake.decomposers,
    redactor: createRedactor("secrets"),
  });
  return Effect.runPromise(translator.translate(documentSet([document(".lando.yml", text)])));
};

test("lowers catalog services when a document declares database and node", async () => {
  // Given / When
  const result = await translate(
    'services:\n  database: {type: "mysql:8.0", portforward: true}\n  node: {type: "node:22", globals: {pnpm: "latest-10"}}\n',
  );
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    {
      services: {
        database: { type: "mysql:8.0", ports: ["3306"] },
        node: { type: "node:22", globals: { pnpm: "latest-10" } },
      },
    },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "rewritten", keyPath: ["services", "database", "portforward"] },
    { kind: "rewritten", keyPath: ["services", "node", "globals"] },
  ]);
});

test("blocks a service when a Compose override is rejected", async () => {
  // Given / When
  const result = await translate('services: {node: {type: "node:22", overrides: {tty: true}}}');
  // Then
  expect(result.outputs).toEqual([]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "unsupported", keyPath: ["services", "node", "overrides", "tty"] },
  ]);
});

test("blocks an unavailable version without manufacturing an image", async () => {
  // Given / When
  const result = await translate('services: {cache: {type: "memcached:1.6"}}');
  // Then
  expect(result.outputs).toEqual([]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "unsupported", keyPath: ["services", "cache", "type"] },
  ]);
  expect(result.diagnostics[0]?.message).toContain("1.6");
});

test("flattens a raw service when nested Compose fields are authored", async () => {
  // Given / When
  const result = await translate(
    'services:\n  web:\n    type: lando\n    services: {image: "nginx:latest", command: nginx, ports: ["8080:80"]}\n    meUser: www-data\n    ssl: true\n',
  );
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    {
      services: {
        web: {
          type: "compose",
          image: "nginx:latest",
          command: "nginx",
          ports: ["8080:80"],
          user: "www-data",
          certs: true,
        },
      },
    },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "rewritten", keyPath: ["services", "web", "meUser"] },
    { kind: "rewritten", keyPath: ["services", "web", "ssl"] },
  ]);
});

test("uses Compose fallback when an unknown type has an image", async () => {
  // Given / When
  const result = await translate('services: {custom: {type: frobnicator, overrides: {image: "custom:1"}}}');
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    { services: { custom: { type: "compose", image: "custom:1" } } },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "rewritten", keyPath: ["services", "custom", "type"] },
  ]);
});

test("blocks an unknown type when it has no image", async () => {
  // Given / When
  const result = await translate("services: {custom: {type: frobnicator}}");
  // Then
  expect(result.outputs).toEqual([]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "unsupported", keyPath: ["services", "custom"] },
  ]);
});

test("orders root hooks before user hooks when both are authored", async () => {
  // Given / When
  const result = await translate(
    'services: {node: {type: "node:22", build: ["npm install"], build_as_root: ["mkdir /cache"]}}',
  );
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    {
      services: {
        node: {
          type: "node:22",
          build: { artifact: [{ run: "mkdir /cache", user: "root" }, { run: "npm install" }] },
        },
      },
    },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "rewritten", keyPath: ["services", "node", "build"] },
  ]);
});

test("hoists a removed service when a higher layer disables it", async () => {
  // Given
  const fake = fakeDecomposers();
  const translator = makeLando3ConfigTranslator({
    decomposers: fake.decomposers,
    redactor: createRedactor("secrets"),
  });
  const input = documentSet([
    document(".lando.base.yml", 'services: {redis: {type: "redis:7"}}'),
    document(".lando.yml", "services: {redis: false}"),
  ]);
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(
    mergeLandofiles(result.outputs.flatMap(({ fragment }) => (isPlainRecord(fragment) ? [fragment] : []))),
  ).toEqual({});
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "needs-review", keyPath: ["services"] },
  ]);
});

test("moves Compose includes and excludes when top-level settings are authored", async () => {
  // Given / When
  const result = await translate(
    'compose: [docker-compose.yml]\nexcludes: [vendor]\nservices: {node: {type: "node:22"}}',
  );
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    {
      includes: [{ source: "docker-compose.yml", kind: "compose" }],
      services: {
        node: { type: "node:22", appMount: { target: "/app", excludes: ["vendor"], includes: [] } },
      },
    },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "rewritten", keyPath: ["compose", 0] },
    { kind: "rewritten", keyPath: ["excludes"] },
  ]);
});

test("overlays authored services while preserving recipe siblings", async () => {
  // Given / When
  const result = await translate(
    'recipe: wordpress\nconfig: {redis: true}\nservices: {appserver: {type: compose, services: {image: "custom:1", command: serve}}}',
  );
  // Then
  const fragment = result.outputs[0]?.fragment;
  expect(isPlainRecord(fragment) ? fragment.services : undefined).toEqual({
    appserver: { type: "compose", image: "custom:1", command: "serve" },
    redis: { image: "redis:7" },
  });
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "generated", keyPath: ["recipe"] },
  ]);
});

test("is deterministic when translating the same document set twice", async () => {
  // Given
  const fake = fakeDecomposers();
  const translator = makeLando3ConfigTranslator({
    decomposers: fake.decomposers,
    redactor: createRedactor("secrets"),
  });
  const input = documentSet([
    document(".lando.yml", 'services: {database: {type: "mysql:8.0", portforward: true}}'),
  ]);
  // When
  const results = await Promise.all([
    Effect.runPromise(translator.translate(input)),
    Effect.runPromise(translator.translate(input)),
  ]);
  // Then
  expect(results[1]).toEqual(results[0]);
});

test("keeps diagnostics once when an authored key survives higher prefixes", async () => {
  // Given
  const fake = fakeDecomposers();
  const translator = makeLando3ConfigTranslator({
    decomposers: fake.decomposers,
    redactor: createRedactor("secrets"),
  });
  const input = documentSet([
    document(".lando.base.yml", 'services: {database: {type: "mysql:8.0", portforward: true}}'),
    document(".lando.yml", "name: app"),
  ]);
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(
    result.diagnostics.map(({ kind, keyPath, sourceId }) => ({ kind, keyPath, sourceId: String(sourceId) })),
  ).toEqual([
    { kind: "rewritten", keyPath: ["services", "database", "portforward"], sourceId: ".lando.base.yml" },
  ]);
});

test("keeps authored services when a generated PHP companion collides", async () => {
  // Given / When
  const result = await translate(
    'services:\n  app: {type: "php:8.3", via: nginx}\n  app-nginx: {type: "node:22"}',
  );
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    {
      services: { app: { type: "php:8.3", via: "fpm" }, "app-nginx": { type: "node:22" } },
    },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "unsupported", keyPath: ["services", "app"] },
    { kind: "generated", keyPath: ["services", "app", "via"] },
    { kind: "rewritten", keyPath: ["services", "app", "via"] },
  ]);
});

test("dispatches API-4 services with hooks and Compose overrides", async () => {
  // Given / When
  const result = await translate(
    'services: {app: {api: 4, image: "alpine:3", build: {image: ["touch /ready"]}, overrides: {command: serve}}}',
  );
  // Then
  expect(result.outputs.map(({ fragment }) => fragment)).toEqual([
    {
      services: {
        app: {
          type: "lando",
          image: "alpine:3",
          build: { artifact: [{ run: "touch /ready" }] },
          command: "serve",
        },
      },
    },
  ]);
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "rewritten", keyPath: ["services", "app", "build"] },
  ]);
});
