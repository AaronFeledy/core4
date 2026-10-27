import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { parseGuideScenarioAst, renderScenarioTest } from "../../../scripts/build-guide-scenarios.ts";
import {
  buildRecipeReadmes,
  discoverRecipeReadmeMdxFiles,
  stripRecipeReadme,
} from "../../../scripts/build-recipe-readmes.ts";
import { GuideSemanticError } from "../../../scripts/guides/diagnostic.ts";

const HAPPY_MDX = `---
id: sample-recipe
provider: test
---

# Sample recipe

Set up the **sample** stack on your machine.

<Guide>
  <Scenario id="reader-path" render>
    <Step name="scaffold">
      <Variable name="appName" value="sample" display="My Sample App" />
      <Run command="lando init --recipe sample --name={{appName}} --yes" />
    </Step>
    <Step name="inspect-config">
      <Inspect output />
    </Step>
    <Step name="teardown">
      <Cleanup />
      <Run command="lando destroy -y" />
      <Verify event="post-destroy" />
    </Step>
  </Scenario>
  <Scenario id="hidden-regression" render={false} reason="Regression coverage only path">
    <Step name="break-it">
      <Run command="lando start --broken" />
    </Step>
  </Scenario>
</Guide>
`;

const TABS_MDX = `---
id: tabbed-recipe
provider: test
axes:
  db: [postgres, mysql]
---

# Tabbed recipe

<Guide>
  <Scenario id="reader-path" render>
    <Tabs axis="db">
      <Tab name="postgres">
        <Step name="configure">
          <Run command="lando init --db=postgres" />
        </Step>
      </Tab>
      <Tab name="mysql">
        <Step name="configure">
          <Run command="lando init --db=mysql" />
        </Step>
      </Tab>
    </Tabs>
  </Scenario>
</Guide>
`;

const INLINE_MDX = `---
id: inline-recipe
provider: test
---

<Guide>
  <Scenario id="reader-path" render>
    <Step name="snippet">
      <Inline lang="ts" code="export const answer = 42;" justification="demonstrates the embedding API" />
    </Step>
  </Scenario>
</Guide>
`;

const SCAFFOLD_STRIP_MDX = `---
id: verbatim-recipe
provider: test
---

<Guide scaffoldStrip={false}>
  <Scenario id="reader-path" render>
    <Step name="scaffold">
      <Run command="lando init" />
    </Step>
  </Scenario>
</Guide>
`;

const writeRecipe = async (root: string, id: string, mdx: string): Promise<void> => {
  await mkdir(join(root, "recipes", id), { recursive: true });
  await Bun.write(join(root, "recipes", id, "README.mdx"), mdx);
};

const withTempRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-recipe-readme-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe("build-recipe-readmes strip/flatten", () => {
  test("discovers recipe README MDX files deterministically", async () => {
    await withTempRoot(async (root) => {
      await writeRecipe(root, "zeta", "---\nid: zeta\n---\n\n<Guide />\n");
      await writeRecipe(root, "alpha", "---\nid: alpha\n---\n\n<Guide />\n");
      await mkdir(join(root, "recipes", "no-readme"), { recursive: true });
      expect(await discoverRecipeReadmeMdxFiles(root)).toEqual([
        "recipes/alpha/README.mdx",
        "recipes/zeta/README.mdx",
      ]);
    });
  });

  test("missing recipes directory yields no files and no error", async () => {
    await withTempRoot(async (root) => {
      expect(await discoverRecipeReadmeMdxFiles(root)).toEqual([]);
      expect(await buildRecipeReadmes(root)).toEqual([]);
    });
  });

  test.each([true, false])("isolates scenarios sharing a source line (first render=%s)", (render) => {
    const scenario = (id: string, display: string, visible: boolean) =>
      `<Scenario id="${id}" render={${visible}} reason="Regression coverage only path"><Step name="${id}"><Variable name="app" value="${id}" display="${display}" /><Run command="lando info {{app}}" /></Step></Scenario>`;
    const source = `---\nid: same-line\nprovider: test\n---\n<Guide>${scenario("first", "first-display", render)}${scenario("second", "second-display", true)}</Guide>`;

    const guide = parseGuideScenarioAst("recipes/same-line/README.mdx", source);
    expect(guide.scenarios[0]?.line).toBe(guide.scenarios[1]?.line);

    const [output] = stripRecipeReadme("recipes/same-line/README.mdx", source);
    const commands = [...(output?.markdown.match(/lando info [^\n]+/g) ?? [])];
    expect(commands).toEqual([...(render ? ["lando info first-display"] : []), "lando info second-display"]);
  });

  test("strips the full component vocabulary into plain Markdown", () => {
    const [output, ...rest] = stripRecipeReadme("recipes/sample-recipe/README.mdx", HAPPY_MDX);
    expect(rest).toHaveLength(0);
    expect(output?.relativePath).toBe("recipes/sample-recipe/.scaffold/default.md");
    const md = output?.markdown ?? "";

    // Prose preserved.
    expect(md).toContain("# Sample recipe");
    expect(md).toContain("Set up the **sample** stack on your machine.");
    // <Step> becomes a numbered heading; <Cleanup> step is excluded from numbering.
    expect(md).toContain("## 1. scaffold");
    expect(md).toContain("## 2. inspect-config");
    expect(md).not.toContain("## 3.");
    // <Run> becomes a fenced bash block of the displayed command (display interpolation).
    expect(md).toContain("```bash\nlando init --recipe sample --name=My Sample App --yes\n```");
    // <Inspect> placeholder.
    expect(md).toContain("(generated at runtime)");
    // <Cleanup> defers its <Run> command to the final Cleanup block.
    expect(md).toContain("## Cleanup");
    expect(md).toContain("lando destroy -y");

    // No executable-component artifacts, imports, raw interpolation, or test-only content.
    for (const artifact of [
      "<Guide",
      "<Scenario",
      "<Step",
      "<Run",
      "<Verify",
      "<Inspect",
      "<Cleanup",
      "<Variable",
      "import ",
      "{{appName}}",
      "post-destroy",
      "hidden-regression",
      "lando start --broken",
    ]) {
      expect(md).not.toContain(artifact);
    }
  });

  test("resolves <Tabs>/<Tab> to one stripped file per axis-value combination", () => {
    const outputs = stripRecipeReadme("recipes/tabbed-recipe/README.mdx", TABS_MDX);
    const byPath = Object.fromEntries(outputs.map((o) => [o.relativePath, o.markdown]));
    expect(Object.keys(byPath).sort()).toEqual([
      "recipes/tabbed-recipe/.scaffold/mysql.md",
      "recipes/tabbed-recipe/.scaffold/postgres.md",
    ]);
    expect(byPath["recipes/tabbed-recipe/.scaffold/postgres.md"]).toContain("lando init --db=postgres");
    expect(byPath["recipes/tabbed-recipe/.scaffold/postgres.md"]).not.toContain("--db=mysql");
    expect(byPath["recipes/tabbed-recipe/.scaffold/mysql.md"]).toContain("lando init --db=mysql");
    expect(byPath["recipes/tabbed-recipe/.scaffold/mysql.md"]).not.toContain("--db=postgres");
  });

  test("collects variables only from the rendered variant path", () => {
    const mdx = `---
id: variable-scope-recipe
provider: test
axes:
  db: [postgres, mysql]
---

<Guide>
  <Scenario id="reader-path" render>
    <Tabs axis="db">
      <Tab name="postgres">
        <Step name="configure">
          <Variable name="dbName" value="postgres-visible" />
          <Run command="lando init --db={{dbName}}" />
        </Step>
      </Tab>
      <Tab name="mysql">
        <Step name="configure">
          <Variable name="dbName" value="mysql-visible" />
          <Run command="lando init --db={{dbName}}" />
        </Step>
      </Tab>
    </Tabs>
    <Hidden reason="Internal fixture preparation only">
      <Step name="hidden">
        <Variable name="hiddenName" value="hidden-wrong" />
        <Run command="lando version {{hiddenName}}" />
      </Step>
    </Hidden>
  </Scenario>
  <Scenario id="test-only" render={false} reason="Regression coverage only path">
    <Step name="hidden-scenario">
      <Variable name="dbName" value="render-false-wrong" />
      <Run command="lando version {{dbName}}" />
    </Step>
  </Scenario>
</Guide>
`;

    const outputs = stripRecipeReadme("recipes/variable-scope-recipe/README.mdx", mdx);
    const byPath = Object.fromEntries(outputs.map((o) => [o.relativePath, o.markdown]));
    const postgres = byPath["recipes/variable-scope-recipe/.scaffold/postgres.md"] ?? "";
    const mysql = byPath["recipes/variable-scope-recipe/.scaffold/mysql.md"] ?? "";

    expect(postgres).toContain("lando init --db=postgres-visible");
    expect(postgres).not.toContain("mysql-visible");
    expect(postgres).not.toContain("hidden-wrong");
    expect(postgres).not.toContain("render-false-wrong");
    expect(mysql).toContain("lando init --db=mysql-visible");
    expect(mysql).not.toContain("postgres-visible");
    expect(mysql).not.toContain("hidden-wrong");
    expect(mysql).not.toContain("render-false-wrong");
  });

  test("isolates Variable bindings per rendered scenario including cleanup", () => {
    const mdx = `---
id: multi-scenario-vars
provider: test
---

<Guide>
  <Scenario id="alpha-path" render>
    <Step name="scaffold-alpha">
      <Variable name="appName" value="alpha-internal" display="alpha-app" />
      <Run command="lando init --name={{appName}} --yes" />
    </Step>
    <Step name="teardown-alpha">
      <Cleanup />
      <Run command="lando destroy {{appName}}" />
    </Step>
  </Scenario>
  <Scenario id="beta-path" render>
    <Step name="scaffold-beta">
      <Variable name="appName" value="beta-internal" display="beta-app" />
      <Run command="lando init --name={{appName}} --yes" />
    </Step>
    <Step name="teardown-beta">
      <Cleanup />
      <Run command="lando destroy {{appName}}" />
    </Step>
  </Scenario>
</Guide>
`;

    const [output, ...rest] = stripRecipeReadme("recipes/multi-scenario-vars/README.mdx", mdx);
    expect(rest).toHaveLength(0);
    const md = output?.markdown ?? "";

    expect(md.match(/```bash\n[\s\S]*?\n```/g)).toEqual([
      "```bash\nlando init --name=alpha-app --yes\n```",
      "```bash\nlando init --name=beta-app --yes\n```",
      "```bash\nlando destroy alpha-app\nlando destroy beta-app\n```",
    ]);
    expect(md.match(/^## .*$/gm)).toEqual(["## 1. scaffold-alpha", "## 2. scaffold-beta", "## Cleanup"]);
  });

  test.each([true, false])(
    "rejects an omitted Variable independently of scenario insertion order: %s",
    (bindingFirst) => {
      const bound = `<Scenario id="with-var" render>
    <Step name="named">
      <Variable name="appName" value="bound-internal" display="bound-app" />
      <Run command="lando info {{appName}}" />
    </Step>
  </Scenario>`;
      const unbound = `<Scenario id="without-var" render>
    <Step name="plain">
      <Run command="lando info {{appName}}" />
    </Step>
  </Scenario>`;
      const mdx = `---
id: omit-var-recipe
provider: test
---

<Guide>
${(bindingFirst ? [bound, unbound] : [unbound, bound]).join("\n")}
</Guide>
`;

      try {
        stripRecipeReadme("recipes/omit-var-recipe/README.mdx", mdx);
        expect.unreachable("Accepted a scenario with an omitted Variable");
      } catch (error) {
        if (!(error instanceof GuideSemanticError)) throw error;
        expect(error).toMatchObject({
          code: "guide.variable.missing",
          scenario: "without-var",
          name: "appName",
        });
      }
    },
  );

  test("emits the full Cartesian product for a multi-axis guide", () => {
    const mdx = `---
id: matrix-recipe
provider: test
axes:
  db: [postgres, mysql]
  cache: [redis, valkey]
---

<Guide>
  <Scenario id="reader-path" render>
    <Tabs axis="db">
      <Tab name="postgres">
        <Step name="db"><Run command="lando init --db=postgres" /></Step>
      </Tab>
      <Tab name="mysql">
        <Step name="db"><Run command="lando init --db=mysql" /></Step>
      </Tab>
    </Tabs>
    <Tabs axis="cache">
      <Tab name="redis">
        <Step name="cache"><Run command="lando add redis" /></Step>
      </Tab>
      <Tab name="valkey">
        <Step name="cache"><Run command="lando add valkey" /></Step>
      </Tab>
    </Tabs>
  </Scenario>
</Guide>
`;
    const outputs = stripRecipeReadme("recipes/matrix-recipe/README.mdx", mdx);
    const byPath = Object.fromEntries(outputs.map((o) => [o.relativePath, o.markdown]));
    expect(Object.keys(byPath).sort()).toEqual([
      "recipes/matrix-recipe/.scaffold/mysql.redis.md",
      "recipes/matrix-recipe/.scaffold/mysql.valkey.md",
      "recipes/matrix-recipe/.scaffold/postgres.redis.md",
      "recipes/matrix-recipe/.scaffold/postgres.valkey.md",
    ]);
    const cell = byPath["recipes/matrix-recipe/.scaffold/mysql.valkey.md"] ?? "";
    expect(cell).toContain("lando init --db=mysql");
    expect(cell).toContain("lando add valkey");
    expect(cell).not.toContain("postgres");
    expect(cell).not.toContain("redis");
  });

  test("flattens <Inline> into a fenced code block in the declared language", () => {
    const [output] = stripRecipeReadme("recipes/inline-recipe/README.mdx", INLINE_MDX);
    expect(output?.markdown).toContain("```ts\nexport const answer = 42;\n```");
    expect(output?.markdown).not.toContain("<Inline");
    expect(output?.markdown).not.toContain("justification");
  });

  test("renders library Run as a TS fence of displayCode, not code or empty bash", () => {
    const mdx = `---
id: library-run-recipe
provider: test
---

<Guide>
  <Scenario id="reader-path" render>
    <Step name="embed">
      <Run
        runtime="library"
        code="await Effect.runPromise(startApp(internalHandle));"
        displayCode="await Effect.runPromise(startApp(app));"
      />
    </Step>
  </Scenario>
</Guide>
`;

    const [output] = stripRecipeReadme("recipes/library-run-recipe/README.mdx", mdx);
    const md = output?.markdown ?? "";
    expect(md.match(/```[^\n]*\n[\s\S]*?```/g)).toEqual([
      "```ts\nawait Effect.runPromise(startApp(app));\n```",
    ]);
    expect(md).not.toContain("internalHandle");
  });

  test("renders library Run under Cleanup as TS displayCode, preserving adjacent bash order", () => {
    const mdx = `---
id: library-cleanup-recipe
provider: test
---

<Guide>
  <Scenario id="shell-cleanup" render>
    <Step name="work">
      <Variable name="appName" value="internal-name" display="shown-app" />
      <Run command="lando start {{appName}}" />
    </Step>
    <Step name="teardown-shell">
      <Cleanup />
      <Run shell="rm -rf {{appName}}" />
    </Step>
  </Scenario>
  <Scenario id="library-cleanup" render>
    <Step name="teardown-library">
      <Cleanup />
      <Run
        runtime="library"
        code="await Effect.runPromise(destroyApp(secretHandle));"
        displayCode="await Effect.runPromise(destroyApp(app));"
      />
    </Step>
  </Scenario>
  <Scenario id="cli-cleanup" render>
    <Step name="teardown-cli">
      <Cleanup />
      <Run command="lando poweroff" />
    </Step>
  </Scenario>
</Guide>
`;

    const sourcePath = "recipes/library-cleanup-recipe/README.mdx";
    const guide = parseGuideScenarioAst(sourcePath, mdx);
    for (const scenario of guide.scenarios) {
      renderScenarioTest(guide, scenario, undefined, "linux");
    }

    const [output] = stripRecipeReadme(sourcePath, mdx);
    const md = output?.markdown ?? "";
    expect(md).toContain("## Cleanup");
    expect(md.match(/```[^\n]*\n[\s\S]*?```/g)).toEqual([
      "```bash\nlando start shown-app\n```",
      "```bash\nrm -rf {{appName}}\n```",
      "```ts\nawait Effect.runPromise(destroyApp(app));\n```",
      "```bash\nlando poweroff\n```",
    ]);
    expect(md).not.toContain("secretHandle");
    expect(md).not.toContain("internal-name");
  });

  test("copies the MDX verbatim when <Guide scaffoldStrip={false}>", () => {
    const [output] = stripRecipeReadme("recipes/verbatim-recipe/README.mdx", SCAFFOLD_STRIP_MDX);
    expect(output?.markdown).toBe(SCAFFOLD_STRIP_MDX);
  });

  test("buildRecipeReadmes writes stripped files to .scaffold and is idempotent", async () => {
    await withTempRoot(async (root) => {
      await writeRecipe(root, "sample-recipe", HAPPY_MDX);
      const first = await buildRecipeReadmes(root);
      expect(first).toEqual(["recipes/sample-recipe/.scaffold/default.md"]);
      const written = await readFile(join(root, "recipes/sample-recipe/.scaffold/default.md"), "utf8");
      expect(written).toContain("## 1. scaffold");
      expect(written).not.toContain("<Run");
      const second = await buildRecipeReadmes(root);
      expect(second).toEqual(first);
      const rewritten = await readFile(join(root, "recipes/sample-recipe/.scaffold/default.md"), "utf8");
      expect(rewritten).toBe(written);
    });
  });
});
