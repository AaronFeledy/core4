import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option } from "effect";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { loadLandofileLayers } from "../src/service.ts";

const withApp = async <A>(run: (appRoot: string) => Promise<A>): Promise<A> => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-route-hostname-"));
  try {
    return await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

const resolveValue = (appRoot: string, value: unknown) =>
  resolveLandofileLoadExpressions({
    value,
    source: {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical",
    },
    policy: DEFAULT_LANDOFILE_LOAD_POLICY,
  });

const publicUrl = "{{ services.web.url }}";

test("defers a public URL in a Compose service environment map", () =>
  withApp(async (appRoot) => {
    const value = { services: { web: { type: "compose", environment: { URL: publicUrl } } } };
    const resolved = await Effect.runPromise(resolveValue(appRoot, value));
    expect(resolved.pendingSites.map((site) => site.path)).toEqual([
      ["services", "web", "environment", "URL"],
    ]);
  }));

test.each([
  [{ tooling: { demo: `curl ${publicUrl}` } }, ["tooling", "demo"]],
  [{ tooling: { demo: { cmd: `curl ${publicUrl}` } } }, ["tooling", "demo", "cmd"]],
  [{ tooling: { demo: { cmd: ["curl", publicUrl] } } }, ["tooling", "demo", "cmd", 1]],
  [{ tooling: { demo: { cmds: [`curl ${publicUrl}`] } } }, ["tooling", "demo", "cmds", 0]],
  [{ tooling: { demo: { cmds: [{ cmd: `curl ${publicUrl}` }] } } }, ["tooling", "demo", "cmds", 0, "cmd"]],
  [
    { tooling: { demo: { cmds: [{ cmd: "true", env: { URL: publicUrl } }] } } },
    ["tooling", "demo", "cmds", 0, "env", "URL"],
  ],
  [{ tooling: { demo: { env: { URL: publicUrl } } } }, ["tooling", "demo", "env", "URL"]],
  [{ tooling: { demo: { vars: { site: publicUrl } } } }, ["tooling", "demo", "vars", "site"]],
  [
    { tooling: { demo: { vars: { site: { sh: `echo ${publicUrl}` } } } } },
    ["tooling", "demo", "vars", "site", "sh"],
  ],
  [
    { tooling: { demo: { vars: { site: { sh: "echo $URL", env: { URL: publicUrl } } } } } },
    ["tooling", "demo", "vars", "site", "env", "URL"],
  ],
  [{ tooling: { demo: { cmd: "{{ url.parse(services.web.url).hostname }}" } } }, ["tooling", "demo", "cmd"]],
  [{ tooling: { demo: { cmd: '{{ services["web"].url }}' } } }, ["tooling", "demo", "cmd"]],
  [{ tooling: { demo: { cmd: "{{ (services.web).url }}" } } }, ["tooling", "demo", "cmd"]],
  [{ toolingDefaults: { env: { URL: publicUrl } } }, ["toolingDefaults", "env", "URL"]],
  [{ toolingDefaults: { vars: { site: publicUrl } } }, ["toolingDefaults", "vars", "site"]],
  [{ events: { "post-start": [`curl ${publicUrl}`] } }, ["events", "post-start", 0]],
  [{ events: { "post-start": [{ cmd: `curl ${publicUrl}` }] } }, ["events", "post-start", 0, "cmd"]],
  [{ events: { "post-start": [{ defer: `curl ${publicUrl}` }] } }, ["events", "post-start", 0, "defer"]],
  [
    { events: { "post-start": [{ cmd: "true", env: { URL: publicUrl } }] } },
    ["events", "post-start", 0, "env", "URL"],
  ],
  [
    { events: { "post-start": [{ cmd: "true", if: "{{ services.web.url != '' }}" }] } },
    ["events", "post-start", 0, "if"],
  ],
  // Event phase is checked when the step runs, so load admits every event name.
  [{ events: { "pre-start": [`curl ${publicUrl}`] } }, ["events", "pre-start", 0]],
])("defers a public URL read at invocation site %j", (value, path) =>
  withApp(async (appRoot) => {
    const resolved = await Effect.runPromise(resolveValue(appRoot, value));
    expect(resolved.pendingSites.map((site) => site.path)).toEqual([path]);
  }),
);

test.each([
  [{ services: { web: { environment: [`URL=${publicUrl}`] } } }, ["services", "web", "environment", 0]],
  [{ services: { web: { command: publicUrl } } }, ["services", "web", "command"]],
  [{ services: { web: { command: "{{ service.url }}" } } }, ["services", "web", "command"]],
  [{ tooling: { demo: { cmd: "curl {{ service.url }}" } } }, ["tooling", "demo", "cmd"]],
  [{ events: { "post-start": ["curl {{ service.url }}"] } }, ["events", "post-start", 0]],
  [{ tooling: { demo: { cmd: "true", dir: publicUrl } } }, ["tooling", "demo", "dir"]],
  [{ tooling: { demo: { cmd: "true", user: publicUrl } } }, ["tooling", "demo", "user"]],
  [{ tooling: { demo: { cmd: "true", service: publicUrl } } }, ["tooling", "demo", "service"]],
  [
    { tooling: { demo: { cmds: [{ cmd: "true", service: publicUrl }] } } },
    ["tooling", "demo", "cmds", 0, "service"],
  ],
  [
    { tooling: { demo: { vars: { site: { sh: "true", service: publicUrl } } } } },
    ["tooling", "demo", "vars", "site", "service"],
  ],
  [{ toolingDefaults: { dir: publicUrl } }, ["toolingDefaults", "dir"]],
  [
    { events: { "post-start": [{ cmd: "true", service: publicUrl }] } },
    ["events", "post-start", 0, "service"],
  ],
  [{ events: { "post-start": [{ task: publicUrl }] } }, ["events", "post-start", 0, "task"]],
  [
    { events: { "post-start": [{ task: "demo", vars: { site: publicUrl } }] } },
    ["events", "post-start", 0, "vars", "site"],
  ],
  [
    { events: { "post-start": [{ command: "app:info", flags: { site: publicUrl } }] } },
    ["events", "post-start", 0, "flags", "site"],
  ],
  [{ tooling: { demo: { cmd: "curl {{ services[vars.name].url }}" } } }, ["tooling", "demo", "cmd"]],
  [{ tooling: { demo: { cmd: "true", dir: "{{ services[vars.name].url }}" } } }, ["tooling", "demo", "dir"]],
  [
    { tooling: { demo: { cmd: "true", dir: "{{ services.web[env.M] }}{{ services[env.NAME].url }}" } } },
    ["tooling", "demo", "dir"],
  ],
  [
    { events: { "post-start": [{ task: "{{ services[vars.name].url }}" }] } },
    ["events", "post-start", 0, "task"],
  ],
  [{ tooling: { demo: { cmd: "curl {{ services.web[vars.member] }}" } } }, ["tooling", "demo", "cmd"]],
  [{ tooling: { demo: { cmd: "curl {{ services.web }}" } } }, ["tooling", "demo", "cmd"]],
  [{ "x-note": publicUrl }, ["x-note"]],
  [
    { services: { web: { environment: { URL: { _tag: "RouteText", parts: [] } } } } },
    ["services", "web", "environment", "URL"],
  ],
])("locates forbidden public URL sites at %j", (value, path) =>
  withApp(async (appRoot) => {
    const result = await Effect.runPromise(resolveValue(appRoot, value).pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileValidationError", issues: [{ path, rule: "unsupported-expression" }] },
    });
  }),
);

test.each(["info", "service"])("names the unsupported %s scope", (scope) =>
  withApp(async (appRoot) => {
    const result = await Effect.runPromise(
      resolveValue(appRoot, { services: { web: { environment: { URL: `{{ ${scope}.routes }}` } } } }).pipe(
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileValidationError", message: expect.stringContaining(`\`${scope}\``) },
    });
  }),
);

describe("landofile load-time route hostname expressions", () => {
  test("keeps an app/proxy hostname template unevaluated", async () => {
    await withApp(async (appRoot) => {
      // Given
      const hostname = "{{ app.name }}.{{ proxy.defaultDomain }}";
      const value = {
        services: {
          appserver: {
            routes: [{ hostname }],
          },
        },
      };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("keeps an env expression unevaluated for the post-merge materializer", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { image: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}" };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("keeps a services.<name>.creds expression unevaluated for the planner", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = {
        services: {
          web: {
            environment: {
              DATABASE_URL:
                "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ app.name }}",
            },
          },
        },
      };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("keeps an exact service environment secret reference for provider input resolution", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { services: { appserver: { environment: { API_TOKEN: "${secret:API_TOKEN}" } } } };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("compiles an authored exact service environment reference without resolving it", async () => {
    await withApp(async (appRoot) => {
      // Given
      await writeFile(
        join(appRoot, ".lando.yml"),
        'name: secret-app\nservices:\n  appserver:\n    type: node\n    environment:\n      API_TOKEN: "${secret:API_TOKEN}"\n',
      );

      // When
      const landofile = await Effect.runPromise(loadLandofileLayers(appRoot, join(appRoot, ".lando.yml")));

      // Then
      expect(landofile.document.services?.[ServiceName.make("appserver")]?.environment?.API_TOKEN).toEqual({
        _tag: "SecretRef",
        reference: "API_TOKEN",
      });
    });
  });

  test("rejects secret references outside authorized binding sites", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { services: { appserver: { image: "${secret:IMAGE}" } } };

      // When
      const exit = await Effect.runPromiseExit(resolveValue(appRoot, value));

      // Then
      if (Exit.isSuccess(exit)) throw new Error("expected unsupported expression rejection");
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        _tag: "LandofileValidationError",
        message: expect.stringContaining("Secret references are not supported"),
        remediation: expect.any(String),
        issues: [
          {
            path: ["services", "appserver", "image"],
            rule: "unsupported-secret-reference",
          },
        ],
      });
    });
  });

  test("still rejects expressions that reach the host", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { hostname: "{{ which('php') }}" };

      // When
      const exit = await Effect.runPromiseExit(resolveValue(appRoot, value));

      // Then
      if (Exit.isSuccess(exit)) throw new Error("expected unsupported expression rejection");
      const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(failure).toMatchObject({
        _tag: "LandofileValidationError",
        issues: [{ path: ["hostname"], rule: "unsupported-expression" }],
      });
      if (failure instanceof LandofileValidationError) {
        expect(failure.message).not.toMatch(/\b(?:Alpha|Beta)\b/);
      }
    });
  });
});
