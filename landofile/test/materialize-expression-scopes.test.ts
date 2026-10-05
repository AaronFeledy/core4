import { expect, test } from "bun:test";
import {
  LOAD_DEFERRED_EXPRESSION_SCOPES,
  PLAN_IDENTITY_EXPRESSION_SCOPES,
  PLAN_SERVICE_EXPRESSION_SCOPES,
  materializeExpressionScopes,
  materializeLoadScopeExpressions,
} from "@lando/landofile/recipe-expressions";

const input = {
  scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
  context: {
    app: { name: "dcms-demo", slug: "dcms-demo" },
    proxy: { defaultDomain: "example.test" },
    recipe: { flavor: "cms" },
    env: { FLAVOR: "host" },
  },
};

test("materializes app, proxy, recipe, and env throughout nested values", () => {
  const source = {
    services: { database: { database: "{{ app.name }}" } },
    tooling: { install: { cmd: 'echo "$PWD" {{ app.slug }}.{{ proxy.defaultDomain }}' } },
    configs: [{ content: "{{ app.name }}-{{ recipe.flavor }}-{{ env.FLAVOR }}" }],
  };
  const result = materializeExpressionScopes(source, "/app/.lando.yml", input);
  expect(result.unresolved).toEqual([]);
  expect(result.value).toEqual({
    services: { database: { database: "dcms-demo" } },
    tooling: { install: { cmd: 'echo "$PWD" dcms-demo.example.test' } },
    configs: [{ content: "dcms-demo-cms-host" }],
  });
  expect(source.services.database.database).toBe("{{ app.name }}");
});

test.each(["${VAR}", "${secret:token}"])("leaves unescaped %s sites untouched", (shell) => {
  const source = { cmd: `echo {{ app.name }} ${shell}` };
  const result = materializeExpressionScopes(source, "/app/.lando.yml", input);
  expect(result.value).toBe(source);
  expect(result.unresolved).toEqual([]);
});

test("materializes beside an escaped braced form", () => {
  const result = materializeExpressionScopes({ cmd: "{{ app.name }} $${VAR}" }, "/app/.lando.yml", input);
  expect(result.value.cmd).toBe("dcms-demo ${VAR}");
});

test("preserves recipe provenance even when other sites change", () => {
  const recipe = { options: { name: "{{ app.name }}" } };
  const source = { recipe, cmd: "{{ app.name }}" };
  const result = materializeExpressionScopes(source, "/app/.lando.yml", input);
  expect(result.value.cmd).toBe("dcms-demo");
  expect(result.value.recipe).toBe(recipe);
  expect(result.value.recipe.options.name).toBe("{{ app.name }}");
});

test("preserves identity when no eligible sites change", () => {
  const source = { plain: "text", nested: ["{{ service.name }}", "{{ app."] };
  const result = materializeExpressionScopes(source, "/app/.lando.yml", input);
  expect(result.value).toBe(source);
  expect(result.unresolved).toEqual([]);
});

test("defers services.* at load, reports the deferred sites, and resolves them with the service scopes", () => {
  expect(LOAD_DEFERRED_EXPRESSION_SCOPES).toContain("services");
  expect(PLAN_IDENTITY_EXPRESSION_SCOPES).not.toContain("services");
  const source = {
    env: { URL: "db://{{ services.database.creds.user }}@{{ app.name }}", HOST: "{{ app.name }}" },
    cmds: ["{{ services.database.creds.database }}"],
  };
  const identity = materializeExpressionScopes(source, "/app/.lando.yml", input);
  expect(identity.value).toEqual({ ...source, env: { ...source.env, HOST: "dcms-demo" } });
  expect(identity.unresolved).toEqual([]);
  expect(identity.deferred).toEqual([
    { path: ["env", "URL"], expression: source.env.URL },
    { path: ["cmds", 0], expression: "{{ services.database.creds.database }}" },
  ]);
  const resolved = materializeExpressionScopes(identity.value, "/app/.lando.yml", {
    scopes: PLAN_SERVICE_EXPRESSION_SCOPES,
    context: { ...input.context, services: { database: { creds: { user: "lando", database: "db" } } } },
  });
  expect(resolved.value).toEqual({ env: { URL: "db://lando@dcms-demo", HOST: "dcms-demo" }, cmds: ["db"] });
  expect(resolved.deferred).toEqual([]);
});

test("evaluates only the sites the eligible predicate accepts, by value and path", () => {
  const source = { authored: "{{ app.name }}", fromFile: "{{ app.name }}", nested: ["{{ app.slug }}"] };
  const result = materializeExpressionScopes(source, "/app/.lando.yml", {
    ...input,
    eligible: (_value, path) => path.join(".") === "authored" || path.join(".") === "nested.0",
  });
  expect(result.value).toEqual({ authored: "dcms-demo", fromFile: "{{ app.name }}", nested: ["dcms-demo"] });
  expect(result.unresolved).toEqual([]);
  expect(result.deferred).toEqual([]);
});

test("reports evaluation failures with their exact value path", () => {
  const source = { services: { database: { database: "{{ app.nope }}" } } };
  const result = materializeExpressionScopes(source, "/app/.lando.yml", input);
  expect(result.value).toBe(source);
  expect(result.unresolved).toMatchObject([
    { path: ["services", "database", "database"], expression: "{{ app.nope }}" },
  ]);
});

test("enforces the supplied evaluation budget", () => {
  const result = materializeExpressionScopes({ cmd: "{{ app.name }}" }, "/app/.lando.yml", {
    ...input,
    budget: { maxSteps: 0, maxDepth: 32, maxOutputBytes: 65536, maxCollectionSize: 256 },
  });
  expect(result.unresolved).toMatchObject([{ path: ["cmd"], expression: "{{ app.name }}" }]);
  expect(result.unresolved[0]?.reason).toContain("Expression budget exceeded");
});

test("keeps loader rejection of recipe defaults without recorded options", () => {
  const source = { cmd: '{{ default(recipe.flavor, "cms") }}' };
  const result = materializeLoadScopeExpressions(source, "/app/.lando.yml", {});
  expect(result.value).toBe(source);
  expect(result.unresolved).toEqual([{ path: ["cmd"], reason: "the Landofile records no recipe options" }]);
});
