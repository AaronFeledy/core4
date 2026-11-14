import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TemplateRenderContext } from "@lando/sdk/schema";
import type { CompiledTemplate, TemplateEngine } from "@lando/sdk/template";
import { Effect } from "effect";
import { recordEnvironment } from "../src/environment-dependencies.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import {
  getLandofileEnvironmentDependencies,
  rememberLandofileEnvironmentDependencies,
} from "../src/load-expression-provenance.ts";
import { renderLandofileTemplate } from "../src/template-render.ts";
import { loadLandofileTs } from "../src/ts-loader.ts";

const envContext = (env: Record<string, string>): TemplateRenderContext => ({
  bootstrapLevel: "app",
  env,
  scope: "landofile",
});

const fakeEngine = (id: string): TemplateEngine => ({
  id,
  extensions: [`.${id}`],
  capabilities: {
    wholeFile: true,
    stringInterpolation: false,
    partials: false,
    unsafe: false,
  },
  compile: (input) =>
    Effect.succeed({
      engineId: id,
      sourceId: input.id,
      run: (context: TemplateRenderContext) =>
        input.source.replace(/\{\{\s*env\.(\w+)\s*\}\}/g, (_match, name: string) => {
          const value = context.env[name];
          return value ?? "";
        }),
    } satisfies CompiledTemplate),
  render: (template, context) => Effect.succeed(template.run(context)),
});

describe("template producer records env reads", () => {
  test("records only names the template reads through the view", async () => {
    const captured = { APP: "demo", OTHER: "x", UNRELATED: "y" };
    const recorder = recordEnvironment(captured);
    const rendered = await Effect.runPromise(
      renderLandofileTemplate({
        filePath: "/app/.lando.yml",
        content: "template: fake\nname: {{ env.APP }}\n",
        registry: new Map([["fake", fakeEngine("fake")]]),
        context: envContext(captured),
        environmentRecorder: recorder,
      }),
    );
    expect(rendered).toContain("demo");
    expect(recorder.dependencies()).toEqual({ _tag: "Names", names: ["APP"] });
    // Raw captured env for compilation remains untracked by the view.
    expect(Object.keys(captured).sort()).toEqual(["APP", "OTHER", "UNRELATED"]);
  });

  test("Object.keys on the view marks Complete", async () => {
    const recorder = recordEnvironment({ APP: "demo", OTHER: "x" });
    await Effect.runPromise(
      renderLandofileTemplate({
        filePath: "/app/.lando.yml",
        content: "template: fake\nname: {{ env.APP }}\n",
        registry: new Map([
          [
            "fake",
            {
              ...fakeEngine("fake"),
              render: (template, context) => {
                // Engine enumerates env — dependency set must become Complete.
                void Object.keys(context.env);
                return Effect.succeed(template.run(context));
              },
            },
          ],
        ]),
        context: envContext({ APP: "demo", OTHER: "x" }),
        environmentRecorder: recorder,
      }),
    );
    expect(recorder.dependencies()).toEqual({ _tag: "Complete" });
  });
});

describe("expression producer records deferred and resolved env members", () => {
  test("records env members on deferred pending sites without evaluating them", async () => {
    const recorder = recordEnvironment({ FLAVOR: "host", UNUSED: "no" });
    const resolved = await Effect.runPromise(
      resolveLandofileLoadExpressions({
        value: {
          name: "{{ env.FLAVOR }}",
          note: "{{ env.MISSING }}",
          services: { web: { type: "lando" } },
        },
        source: {
          appRoot: "/app",
          sourceRoot: "/app",
          sourcePath: "/app/.lando.yml",
          layer: "canonical",
        },
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
        environmentRecorder: recorder,
      }),
    );
    expect(resolved.pendingSites.length).toBeGreaterThan(0);
    expect(recorder.dependencies()).toEqual({
      _tag: "Names",
      names: ["FLAVOR", "MISSING"],
    });
  });

  test("unanalyzable env member marks Complete", async () => {
    const recorder = recordEnvironment({ X: "1" });
    await Effect.runPromise(
      resolveLandofileLoadExpressions({
        value: { name: "{{ env[app.name] }}" },
        source: {
          appRoot: "/app",
          sourceRoot: "/app",
          sourcePath: "/app/.lando.yml",
          layer: "canonical",
        },
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
        environmentRecorder: recorder,
      }),
    );
    expect(recorder.dependencies()).toEqual({ _tag: "Complete" });
  });
});

describe("typescript producer records ctx.env reads", () => {
  test("factory reads through the recorder view", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-env-deps-"));
    const filePath = join(dir, ".lando.ts");
    await writeFile(
      filePath,
      `export default (ctx: { env: Record<string, string | undefined> }) => ({
  name: ctx.env.APP_NAME ?? "fallback",
  tag: ctx.env.MISSING_TAG,
});
`,
    );
    const captured = { APP_NAME: "from-env", OTHER: "ignored" };
    const recorder = recordEnvironment(captured);
    const value = await Effect.runPromise(
      loadLandofileTs({
        filePath,
        appRoot: dir,
        content: await Bun.file(filePath).text(),
        env: captured,
        environmentRecorder: recorder,
      }),
    );
    expect(value).toEqual({ name: "from-env", tag: undefined });
    expect(recorder.dependencies()).toEqual({
      _tag: "Names",
      names: ["APP_NAME", "MISSING_TAG"],
    });
  });
});

describe("raw env vs view separation", () => {
  test("enumerating the raw capture does not mark the recorder Complete", () => {
    const captured = { A: "1", B: "2", C: "3" };
    const recorder = recordEnvironment(captured);
    // CompilationContext / redaction style walk over the raw object.
    expect(Object.keys(captured).sort()).toEqual(["A", "B", "C"]);
    expect(Object.entries(captured).length).toBe(3);
    expect(recorder.dependencies()).toEqual({ _tag: "Names", names: [] });
    expect(recorder.view.A).toBe("1");
    expect(recorder.dependencies()).toEqual({ _tag: "Names", names: ["A"] });
  });
});

describe("remembered deps stay provenance-only", () => {
  test("getLandofileEnvironmentDependencies returns Names without values", () => {
    const landofile = { name: "app" };
    const recorder = recordEnvironment({ SECRET: "value" });
    expect(recorder.view.SECRET).toBe("value");
    rememberLandofileEnvironmentDependencies(landofile, recorder.dependencies());
    expect(getLandofileEnvironmentDependencies(landofile)).toEqual({
      _tag: "Names",
      names: ["SECRET"],
    });
    expect(JSON.stringify(getLandofileEnvironmentDependencies(landofile))).not.toContain("value");
  });
});
