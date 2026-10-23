import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadScopedLandofile, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { consumeSites } from "../src/compiled-sites.ts";
import { loadAuthoredDocuments } from "../src/root-compile.ts";
import { loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const envOf = (compiled: LoadScopedLandofile, name = "web") =>
  compiled.document.services?.[ServiceName.make(name)]?.environment;
const load = (value: unknown) =>
  Effect.runPromise(
    loadAuthoredDocuments([{ file: "/app/.lando.yml", value }], { appRoot: "/app", file: "/app/.lando.yml" }),
  );
const advance = (compiled: LoadScopedLandofile) =>
  consumeSites({
    document: compiled.document,
    pendingSites: compiled.pendingSites,
    context: { env: compiled.context.env, app: { name: "resolved" } },
    scopes: ["env", "app"],
  });

test("keeps equal-looking produced strings inert while consuming only recorded ASTs", async () => {
  const before = process.env.LANE_B_DATA;
  process.env.LANE_B_DATA = "{{ app.name }}";
  try {
    const compiled = await load({
      services: { web: { environment: { AUTHORED: "{{ app.name }}", DATA: "{{ env.LANE_B_DATA }}" } } },
    });
    const result = consumeSites({
      document: compiled.document,
      pendingSites: compiled.pendingSites,
      context: { env: compiled.context.env, app: { name: "resolved" } },
      scopes: ["env", "app"],
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result))
      expect(result.success).toMatchObject({
        pendingSites: [],
        document: { services: { web: { environment: { AUTHORED: "resolved", DATA: "{{ app.name }}" } } } },
      });
  } finally {
    process.env.LANE_B_DATA = before;
  }
});

test.each(["$${BROKEN}", "{{{{", "${secret:X}", "{{ malformed ("])(
  "keeps load-produced %s bytes without escaping or reparsing",
  async (literal) => {
    const root = await mkdtemp(join(tmpdir(), "lando-compiled-data-"));
    try {
      await Bun.write(join(root, "data.txt"), literal);
      await Bun.write(
        join(root, ".lando.yml"),
        "services:\n  web:\n    environment:\n      DATA: \"{{ load('./data.txt') }}\"\n",
      );
      const compiled = await Effect.runPromise(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ports: makeTestLandofilePorts(join(root, "cache")),
          templates: { modules: [] },
        }),
      );
      expect(envOf(compiled)?.DATA).toBe(literal);
      expect(compiled.pendingSites).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("registers mixed, credential, Redis and tooling binding sites without store access", async () => {
  const compiled = await load({
    services: {
      db: {
        creds: { user: "lando", database: "app", password: "${secret:DB}" },
        environment: { URL: "prefix-${secret:DB}" },
      },
      cache: { password: "${secret:CACHE}" },
    },
    tooling: { task: { cmd: "echo", env: { TOKEN: "${secret:TOKEN}" } } },
  });
  expect(compiled.document.services?.[ServiceName.make("db")]?.creds?.password).toEqual({
    _tag: "SecretRef",
    reference: "DB",
  });
  expect(envOf(compiled, "db")?.URL).toEqual({
    _tag: "BoundText",
    parts: ["prefix-", { reference: "DB", encoding: "raw" }],
  });
  expect(compiled.document.services?.[ServiceName.make("cache")]?.password).toEqual({
    _tag: "SecretRef",
    reference: "CACHE",
  });
  expect(compiled.document.tooling?.task?.env?.TOKEN).toEqual({ _tag: "SecretRef", reference: "TOKEN" });
  expect(compiled.pendingSites).toEqual([]);
});

test.each(["SecretRef", "BoundText"])(
  "rejects raw reserved %s objects at their authored path",
  async (_tag) => {
    const result = await load({ services: { web: { environment: { TOKEN: { _tag } } } } }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ path: ["services", "web", "environment", "TOKEN"], source: { file: "/app/.lando.yml" } }],
    });
  },
);

test("retains last-wins list environment origin indices and discards overwritten pending sites", async () => {
  const compiled = await load({
    services: {
      web: { environment: ["DUP={{ app.name }}", "KEEP={{ app.name }}", "DUP=literal", "ESCAPED=$${VAR}"] },
    },
  });
  expect(envOf(compiled)).toEqual({ DUP: "literal", KEEP: "{{ app.name }}", ESCAPED: "${VAR}" });
  expect(compiled.pendingSites).toMatchObject([
    {
      path: ["services", "web", "environment", "KEEP"],
      source: { path: ["services", "web", "environment", 1] },
    },
  ]);
  expect(compiled.pendingSites).toHaveLength(1);
});

test("rebases keyed arrays and aliases through includes, override and reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-compiled-origins-"));
  try {
    await Bun.write(
      join(root, "fragment.yml"),
      'services:\n  web:\n    working_dir: "{{ app.name }}"\n    routes:\n      - hostname: first.test\n      - hostname: second.test\n        pathPrefix: "{{ app.name }}"\n',
    );
    await Bun.write(
      join(root, ".lando.base.yml"),
      'services:\n  web:\n    environment:\n      RESET: "{{ app.name }}"\n      REPLACE: "{{ app.name }}"\n',
    );
    await Bun.write(
      join(root, ".lando.yml"),
      'includes: [./fragment.yml]\nservices:\n  web:\n    routes:\n      - hostname: first.test\n        pathPrefix: /override\n    environment: !override\n      KEEP: "{{ app.name }}"\ntooling: !reset "{{ broken ${SYNTAX}"\n',
    );
    const compiled = await Effect.runPromise(
      loadLandofileLayers(root, join(root, ".lando.yml"), {
        ports: makeTestLandofilePorts(join(root, "cache")),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      }),
    );
    expect(compiled.pendingSites.map((site) => site.path)).toContainEqual([
      "services",
      "web",
      "workingDirectory",
    ]);
    expect(compiled.pendingSites.map((site) => site.path)).toContainEqual([
      "services",
      "web",
      "routes",
      1,
      "pathPrefix",
    ]);
    expect(
      compiled.pendingSites.some((site) => site.path.includes("RESET") || site.path.includes("REPLACE")),
    ).toBe(false);
    const result = advance(compiled);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.pendingSites).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps namespaced tooling pending IDs and original fragment source paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-compiled-tooling-"));
  try {
    await Bun.write(join(root, "tasks.yml"), 'tooling:\n  task:\n    cmd: "echo {{ app.name }}"\n');
    await Bun.write(
      join(root, ".lando.yml"),
      "includes:\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: ns\n    aliases: [alias]\n",
    );
    const compiled = await Effect.runPromise(
      loadLandofileLayers(root, join(root, ".lando.yml"), {
        ports: makeTestLandofilePorts(join(root, "cache")),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      }),
    );
    expect(compiled.pendingSites.map((site) => site.path)).toEqual([
      ["tooling", "ns:task", "cmd"],
      ["tooling", "alias:task", "cmd"],
    ]);
    expect(new Set(compiled.pendingSites.map((site) => site.id)).size).toBe(1);
    expect(compiled.pendingSites[0]?.source).toMatchObject({
      file: join(root, "tasks.yml"),
      path: ["tooling", "task", "cmd"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the same captured environment for mixed-scope sites", async () => {
  const before = process.env.LANE_B_SNAPSHOT;
  try {
    process.env.LANE_B_SNAPSHOT = "captured";
    const compiled = await load({ "x-mixed": "{{ env.LANE_B_SNAPSHOT }}-{{ app.name }}" });
    process.env.LANE_B_SNAPSHOT = "changed";
    const result = advance(compiled);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result))
      expect(result.success.document).toMatchObject({ "x-mixed": "captured-resolved" });
  } finally {
    process.env.LANE_B_SNAPSHOT = before;
  }
});

test("maps schema-transform destinations from surviving origins rather than equal string contents", async () => {
  const compiled = await load({
    env_file: "{{ app.name }}",
    services: {
      web: {
        appMount: "{{ app.name }}",
        envFile: "{{ app.name }}",
        healthcheck: { test: ["CMD-SHELL", "echo {{ app.name }}"] },
        security: { cas: "{{ app.name }}" },
        configs: ["{{ app.name }}"],
      },
    },
  });
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([
    ["env_file", 0],
    ["services", "web", "appMount", "target"],
    ["services", "web", "envFile", 0],
    ["services", "web", "healthcheck", "command"],
    ["services", "web", "security", "ca", 0],
    ["services", "web", "configs", 0, "source"],
  ]);
  const result = advance(compiled);
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result))
    expect(result.success.document).toMatchObject({
      services: { web: { appMount: { target: "resolved" }, healthcheck: { command: "echo resolved" } } },
    });
});
