import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { override, reset, withValueOrigins } from "@lando/sdk/landofile";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  authoredLiteralAt,
  authoredSourceDocument,
  committedSensitiveLiterals,
  sensitiveLandofileOccurrences,
} from "../src/authored-literal.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { rememberOrigins } from "../src/pipeline/origins.ts";
import { rememberSourceDocuments } from "../src/pipeline/source-table.ts";
import { loadLandofileFile } from "../src/service.ts";

test.each(["base", "dist", "upstream", "canonical", "local", "user"] as const)(
  "proves occurrences only from eligible YAML layers: %s",
  async (layer) => {
    const root = await mkdtemp(join(tmpdir(), "lando-literal-proof-"));
    try {
      const file = join(root, ".lando.yml");
      await writeFile(
        file,
        "name: proof\nservices:\n  db:\n    environment:\n      DB_PASSWORD: wordpress\n      NUM_TOKEN: 12345\n",
      );
      const loaded = await Effect.runPromise(
        loadLandofileFile(file, {
          appRoot: root,
          layer,
          policy: DEFAULT_LANDOFILE_LOAD_POLICY,
          pendingSites: [],
          compilationContext: { appRoot: AbsolutePath.make(root), env: {} },
        }),
      );
      expect(authoredLiteralAt(loaded.document, ["services", "db", "environment", "DB_PASSWORD"])).toBe(
        layer === "local" || layer === "user" ? undefined : "wordpress",
      );
      expect(authoredLiteralAt(loaded.document, ["services", "db", "environment", "NUM_TOKEN"])).toBe(
        layer === "local" || layer === "user" ? undefined : "12345",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("proves normalized env-list leaves using their own raw value part", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-list-proof-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(file, "services:\n  db:\n    environment:\n      - DB_PASSWORD=wordpress\n");
    const loaded = await Effect.runPromise(loadLandofileFile(file));
    expect(authoredLiteralAt(loaded.document, ["services", "db", "environment", "DB_PASSWORD"])).toBe(
      "wordpress",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { form: "yaml", content: "template: test\n", raw: "wordpress" },
  { form: "typescript", content: "", raw: "wordpress" },
  { form: "yaml", content: "", raw: "{{ env.PASSWORD }}" },
  { form: "yaml", content: "", raw: "${PASSWORD}" },
  { form: "yaml", content: "", raw: "{{ load('./password') }}" },
  { form: "yaml", content: "", raw: "different" },
] as const)("rejects nonliteral source evidence: %j", ({ form, content, raw }) => {
  const document = { password: "wordpress" };
  rememberOrigins(
    document,
    withValueOrigins(document, (path) => ({ file: "/app/.lando.yml", layer: "canonical" as const, path }))
      .origins,
  );
  rememberSourceDocuments(document, [
    {
      file: "/app/.lando.yml",
      layer: "canonical",
      form,
      content,
      document: { password: raw },
      digest: sha256Hex(content),
    },
  ]);
  expect(authoredLiteralAt(document, ["password"])).toBeUndefined();
});

test("does not turn missing or synthesized origins into occurrence evidence", () => {
  const document = { password: "wordpress" };
  expect(authoredLiteralAt(document, ["password"])).toBeUndefined();
  rememberOrigins(
    document,
    withValueOrigins({}, (path) => ({ file: "/app/.lando.yml", layer: "canonical" as const, path })).origins,
  );
  rememberSourceDocuments(document, [
    {
      file: "/app/.lando.yml",
      layer: "canonical",
      form: "yaml",
      content: "",
      document,
      digest: sha256Hex(""),
    },
  ]);
  expect(authoredLiteralAt(document, ["password"])).toBeUndefined();
});

test("committed proof walks authored directives and list env without proving unrelated leaves", async () => {
  const document = {
    name: "unrelated-name",
    "x-credentials": { password: "extension-only" },
    appEnv: { DB_PASSWORD: "global-only" },
    services: {
      db: {
        creds: override({ password: "wordpress" }),
        password: reset(),
        environment: override(["API_TOKEN=list-private", "PUBLIC=visible"]),
        labels: { "api.secret": "label-private" },
        extensions: { compose: { labels: { "api.token": "compose-private" } } },
      },
    },
    tooling: {
      run: { env: { DB_PASSWORD: "task-private" }, cmds: [{ env: { API_TOKEN: "step-private" } }] },
    },
    toolingDefaults: { env: { API_TOKEN: "default-private" } },
    events: { "post-start": [{ env: { DB_PASSWORD: "event-private" } }] },
  };
  const prepared = await Effect.runPromise(
    authoredSourceDocument({
      file: "/app/.lando.yml",
      form: "yaml",
      layer: "canonical",
      document,
      content: "",
      digest: sha256Hex(""),
    }),
  );
  expect(committedSensitiveLiterals(prepared)).toEqual(
    new Set([
      "wordpress",
      "list-private",
      "label-private",
      "compose-private",
      "task-private",
      "step-private",
      "default-private",
      "event-private",
    ]),
  );
  expect(
    [...sensitiveLandofileOccurrences(prepared)].find(({ value }) => value === "list-private")?.path,
  ).toEqual(["services", "db", "environment", 0]);
});
