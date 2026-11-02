import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { consumeSites } from "../src/compiled-sites.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import {
  PLAN_IDENTITY_EXPRESSION_SCOPES,
  PLAN_SERVICE_EXPRESSION_SCOPES,
} from "../src/recipe-expressions.ts";

const context = {
  app: { name: "dcms-demo", slug: "dcms-demo" },
  proxy: { defaultDomain: "example.test" },
  recipe: { flavor: "cms" },
  env: { FLAVOR: "host" },
};
const compile = (value: unknown) =>
  Effect.runPromise(
    resolveLandofileLoadExpressions({
      value,
      source: { appRoot: "/app", sourceRoot: "/app", sourcePath: "/app/.lando.yml", layer: "canonical" },
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    }),
  );
const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

test("materializes app, proxy, recipe, and env throughout nested values", async () => {
  const compiled = await compile({
    services: { database: { database: "{{ app.name }}" } },
    tooling: { install: { cmd: 'echo "$PWD" {{ app.slug }}.{{ proxy.defaultDomain }}' } },
    configs: [{ content: "{{ app.name }}-{{ recipe.flavor }}-{{ env.FLAVOR }}" }],
  });
  const result = success(
    consumeSites({
      document: compiled.value,
      pendingSites: compiled.pendingSites,
      context,
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    }),
  );
  expect(result.document).toEqual({
    services: { database: { database: "dcms-demo" } },
    tooling: { install: { cmd: 'echo "$PWD" dcms-demo.example.test' } },
    configs: [{ content: "dcms-demo-cms-host" }],
  });
  expect(result.pendingSites).toEqual([]);
});

test.each(["${VAR}", "${secret:token}"])("rejects unescaped %s outside binding sites", async (shell) => {
  const result = await compile({ cmd: `echo {{ app.name }} ${shell}` }).then(
    () => false,
    () => true,
  );
  expect(result).toBe(true);
});

test("materializes beside an escaped braced form once", async () => {
  const compiled = await compile({ cmd: "{{ app.name }} $${VAR}" });
  const result = success(
    consumeSites({
      document: compiled.value,
      pendingSites: compiled.pendingSites,
      context,
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    }),
  );
  expect(result.document).toEqual({ cmd: "dcms-demo ${VAR}" });
});

test("preserves recipe provenance even when other sites change", async () => {
  const compiled = await compile({ recipe: { options: { name: "{{ app.name }}" } }, cmd: "{{ app.name }}" });
  const result = success(
    consumeSites({
      document: compiled.value,
      pendingSites: compiled.pendingSites,
      context,
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    }),
  );
  expect(result.document).toEqual({ recipe: { options: { name: "{{ app.name }}" } }, cmd: "dcms-demo" });
});

test("preserves identity when no recorded sites change", () => {
  const document = { plain: "text", nested: ["{{ service.name }}", "{{ app."] };
  const result = success(
    consumeSites({ document, pendingSites: [], context, scopes: PLAN_IDENTITY_EXPRESSION_SCOPES }),
  );
  expect(result.document).toBe(document);
});

test("defers services.* and consumes its original AST after identity scopes", async () => {
  const compiled = await compile({
    env: { URL: "db://{{ services.database.creds.user }}@{{ app.name }}", HOST: "{{ app.name }}" },
    cmds: ["{{ services.database.creds.database }}"],
  });
  const identity = success(
    consumeSites({
      document: compiled.value,
      pendingSites: compiled.pendingSites,
      context,
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    }),
  );
  expect(identity.pendingSites).toHaveLength(2);
  const resolved = success(
    consumeSites({
      ...identity,
      context: { ...context, services: { database: { creds: { user: "lando", database: "db" } } } },
      scopes: PLAN_SERVICE_EXPRESSION_SCOPES,
    }),
  );
  expect(resolved.document).toEqual({
    env: { URL: "db://lando@dcms-demo", HOST: "dcms-demo" },
    cmds: ["db"],
  });
  expect(resolved.pendingSites).toEqual([]);
});

test("evaluates only explicitly recorded sites with equal-looking literal data", async () => {
  const compiled = await compile({ authored: "{{ app.name }}", nested: ["{{ app.slug }}"] });
  const document = { authored: "{{ app.name }}", fromFile: "{{ app.name }}", nested: ["{{ app.slug }}"] };
  const result = success(
    consumeSites({
      document,
      pendingSites: compiled.pendingSites,
      context,
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    }),
  );
  expect(result.document).toEqual({
    authored: "dcms-demo",
    fromFile: "{{ app.name }}",
    nested: ["dcms-demo"],
  });
});

test("reports evaluation failures with their exact value path", async () => {
  const compiled = await compile({ services: { database: { database: "{{ app.nope }}" } } });
  const result = consumeSites({
    document: compiled.value,
    pendingSites: compiled.pendingSites,
    context,
    scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
  });
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "ConfigExpressionError",
      path: ["services", "database", "database"],
      filePath: "/app/.lando.yml",
    });
});

test("enforces the supplied evaluation budget", async () => {
  const compiled = await compile({ cmd: "{{ app.name }}" });
  const result = consumeSites({
    document: compiled.value,
    pendingSites: compiled.pendingSites,
    context,
    scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    budget: { maxSteps: 0, maxDepth: 32, maxOutputBytes: 65536, maxCollectionSize: 256 },
  });
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure.message).toContain("budget");
});

test("keeps loader rejection of recipe defaults without recorded options", async () => {
  const { loadAuthoredDocuments } = await import("../src/root-compile.ts");
  const result = await Effect.runPromise(
    Effect.result(
      loadAuthoredDocuments(
        [{ file: "/app/.lando.yml", value: { "x-value": '{{ default(recipe.flavor, "cms") }}' } }],
        { appRoot: "/app", file: "/app/.lando.yml" },
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({ _tag: "ConfigExpressionError", path: ["x-value"] });
});
