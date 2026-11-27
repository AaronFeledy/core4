import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TemplateRenderContext } from "@lando/sdk/schema";
import type { CompiledTemplate, TemplateEngine } from "@lando/sdk/template";
import { Effect } from "effect";
import { recordEnvironment } from "../src/environment-dependencies.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { authoredDocumentFrom } from "../src/provenance.ts";
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
    expect(resolved.pendingSites.map((site) => site.path)).toEqual([["name"], ["note"]]);
    expect(resolved.value).toEqual({
      name: "{{ env.FLAVOR }}",
      note: "{{ env.MISSING }}",
      services: { web: { type: "lando" } },
    });
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
  // Loading author code registers process-wide host modules, so it runs in a child process.
  test.each([
    {
      name: "factory reads through the recorder view",
      read: "ctx.env.MISSING_TAG",
      dependencies: { _tag: "Names", names: ["APP_NAME", "MISSING_TAG"] },
    },
    {
      name: "a process.env read cannot be recorded, so the load depends on everything",
      read: "process.env.MISSING_TAG",
      dependencies: { _tag: "Complete" },
    },
    {
      name: "a bracketed Bun env read cannot be recorded either",
      read: `Bun["env"].MISSING_TAG`,
      dependencies: { _tag: "Complete" },
    },
    {
      name: "a local helper that reads process.env makes the load depend on everything",
      header: `import { tag } from "./helper.ts";\n`,
      read: "tag(ctx.env)",
      helper: "export const tag = (_env: Record<string, string | undefined>) => process.env.MISSING_TAG;\n",
      dependencies: { _tag: "Complete" },
    },
    {
      name: "a local helper that requires another module makes the load depend on everything",
      header: `import { tag } from "./helper.ts";\n`,
      read: "tag(ctx.env)",
      helper:
        'require("node:path");\nexport const tag = (env: Record<string, string | undefined>) => env.MISSING_TAG;\n',
      dependencies: { _tag: "Complete" },
    },
    {
      name: "a local helper given ctx.env keeps the recorded names",
      header: `import type { LandofileContext } from "@lando/sdk/landofile";\nimport { tag } from "./helper";\n`,
      read: "tag(ctx.env)",
      helper: "export const tag = (env: Record<string, string | undefined>) => env.MISSING_TAG;\n",
      dependencies: { _tag: "Names", names: ["APP_NAME", "MISSING_TAG"] },
    },
  ])(
    "$name",
    async ({
      header,
      read,
      helper,
      dependencies,
    }: {
      header?: string;
      read: string;
      helper?: string;
      dependencies: unknown;
    }) => {
      const dir = await mkdtemp(join(tmpdir(), "lando-env-deps-"));
      const filePath = join(dir, ".lando.ts");
      if (helper !== undefined) await writeFile(join(dir, "helper.ts"), helper);
      await writeFile(
        filePath,
        `${header ?? ""}export default (ctx: { env: Record<string, string | undefined> }) => ({
  name: ctx.env.APP_NAME ?? "fallback",
  tag: ${read},
});
`,
      );
      const script = `
      const { Effect } = await import("effect");
      const { recordEnvironment } = await import(${JSON.stringify(resolve(import.meta.dirname, "../src/environment-dependencies.ts"))});
      const { loadLandofileTs } = await import(${JSON.stringify(resolve(import.meta.dirname, "../src/ts-loader.ts"))});
      const filePath = ${JSON.stringify(filePath)};
      const captured = { APP_NAME: "from-env", OTHER: "ignored" };
      const recorder = recordEnvironment(captured);
      const value = await Effect.runPromise(loadLandofileTs({
        filePath,
        appRoot: ${JSON.stringify(dir)},
        content: await Bun.file(filePath).text(),
        env: captured,
        environmentRecorder: recorder,
      }));
      console.log(JSON.stringify({ value, hasTag: Object.hasOwn(value, "tag"), dependencies: recorder.dependencies() }));
    `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: resolve(import.meta.dirname, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        child.stdout.text(),
        child.stderr.text(),
      ]);
      expect(exit, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        value: { name: "from-env" },
        hasTag: true,
        dependencies,
      });
    },
  );
});

test.skipIf(process.platform === "win32")(
  "contained symlinked TS entries track names from their physical imports",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-symlink-env-deps-")));
    try {
      const physical = join(root, "config");
      const filePath = join(root, ".lando.ts");
      const content = 'import getName from "./helper"; export default (ctx) => ({ name: getName(ctx.env) });';
      await mkdir(physical);
      await Bun.write(join(physical, "landofile.ts"), content);
      await Bun.write(join(physical, "helper.ts"), "export default (env) => env.APP_NAME;");
      await symlink(join("config", "landofile.ts"), filePath);
      const recorder = recordEnvironment({ APP_NAME: "recorded-name", EXTRA: "ignored" });
      const value = await Effect.runPromise(
        loadLandofileTs({
          filePath,
          appRoot: root,
          content,
          contained: true,
          environmentRecorder: recorder,
        }),
      );
      expect(value).toEqual({ name: "recorded-name" });
      expect(recorder.dependencies()).toEqual({ _tag: "Names", names: ["APP_NAME"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

describe("recorded deps stay provenance-only", () => {
  test("the provenance record carries Names without values", () => {
    const recorder = recordEnvironment({ SECRET: "value" });
    expect(recorder.view.SECRET).toBe("value");
    const document = authoredDocumentFrom(
      { name: "app" },
      { file: "/app/.lando.yml", layer: "canonical", path: [] },
    );
    const dependencies = recorder.dependencies();
    expect(dependencies).toEqual({ _tag: "Names", names: ["SECRET"] });
    expect(JSON.stringify({ ...document.provenance, environmentDependencies: dependencies })).not.toContain(
      "value",
    );
  });
});
