import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  LlmsSerializeError,
  builtFileFor,
  collectLlmsPages,
  fixtureRootsFor,
  llmsIndexUrls,
  renderLlmsFull,
  renderLlmsIndex,
  routeFor,
  serializeDocsPage,
  writeLlmsFiles,
} from "../src/lib/llms.ts";
import { type SourceLinkInventory, createSourceLinkInventory } from "../src/lib/source-links.ts";

const docsRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(docsRoot, "..");
const site = "https://aaronfeledy.github.io";
const base = "/core4/";

const serializeFile = async (file: string, id?: string): Promise<string> =>
  serializeDocsPage(await readFile(file, "utf8"), {
    file,
    fixtureRoots: fixtureRootsFor(docsRoot, id === undefined ? {} : { id }),
  });

// Strip fenced code so assertions only look at prose output.
const prose = (markdown: string): string => markdown.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, "");

describe("llms serializer", () => {
  test("flattens the build-steps guide into plain markdown", async () => {
    const out = await serializeFile(resolve(docsRoot, "guides/services/build-steps.mdx"), "build-steps");

    expect(out).toContain("```sh\nlando app:config:lint --format=json\n```");
    expect(out).toContain(
      `expect: command \`lando app:config:lint --format=json\` \`expect=${JSON.stringify({ stdout: { regex: '"valid":\\s*true' } })}\``,
    );
    expect(out).toContain("Fixture `build-steps-demo`, `.lando.yml`:\n\n```yaml\nname: build-steps-demo\n");
    // render={false} scenario and its fixture are dropped.
    expect(out).not.toContain("build-steps-invalid-user");
    expect(prose(out)).not.toMatch(/<\/?[A-Z][A-Za-z]*[\s/>]/);
    expect(out.startsWith("# ")).toBe(false);
  });

  test("drops Hidden and Cleanup content from a recipe guide", async () => {
    const out = await serializeFile(resolve(repoRoot, "recipes/drupal-cms/README.mdx"), "drupal-cms");

    expect(out).not.toContain("chmod u+w /app/web/sites/default");
    expect(out).toContain("```sh\n");
    expect(prose(out)).not.toMatch(/<\/?[A-Z][A-Za-z]*[\s/>]/);
  });

  test("handles every component form and drops empty or hidden ones", () => {
    const source = [
      "---",
      "id: all-component-forms",
      "provider: test",
      "---",
      "",
      "# Title",
      "",
      "<Guide>",
      '  <Scenario id="a">',
      '    <Step name="s">',
      '      <Variable name="app" value="my-app" display="demo" />',
      '      <Run command="lando start {{app}}" />',
      '      <Verify command="lando info" expect="ok" />',
      '      <Inline code="echo hi" lang="sh" justification="Illustrative command" />',
      "      <Cleanup />",
      "    </Step>",
      '    <Hidden reason="Private setup">',
      '      <Step name="hidden"><Run command="secret-hidden" /></Step>',
      "    </Hidden>",
      '    <Skip reason="Pending support">',
      '      <Step name="skipped"><Run command="secret-skip" /></Step>',
      "    </Skip>",
      "  </Scenario>",
      '  <Scenario id="b"><Step name="t"><Run runtime="library" code="expect(true).toBe(true);" displayCode="const y = 1;" /></Step></Scenario>',
      '  <Scenario id="c" render={false} reason="Internal regression"><Step name="u"><Run command="secret-unrendered" /></Step></Scenario>',
      "</Guide>",
    ].join("\n");

    const out = serializeDocsPage(source, { file: "/x/guide.mdx" });

    expect(out).toContain("`demo`");
    expect(out).toContain("```sh\nlando start demo\n```");
    expect(out).toContain("```ts\nconst y = 1;\n```");
    expect(out).toContain('expect: command `lando info` `expect="ok"`');
    expect(out).toContain("```sh\necho hi\n```");
    expect(out.match(/expect:/g)).toHaveLength(1);
    expect(out).not.toContain("secret-");
    expect(out).not.toContain("Title");
  });

  test("fails loudly on an unknown component with its name and file", () => {
    expect(() => serializeDocsPage("<Mystery foo />\n", { file: "/x/mystery.mdx" })).toThrow(
      LlmsSerializeError,
    );
    expect(() => serializeDocsPage("Text\n\n<Mystery foo />\n", { file: "/x/mystery.mdx" })).toThrow(
      "Unknown MDX component <Mystery> in /x/mystery.mdx:3",
    );
  });

  test("preserves static Verify expectation data without interpreting matchers", () => {
    const verify = (expect: string): string =>
      serializeDocsPage(`<Verify command="c" expect={${expect}} />\n`, { file: "/x/v.mdx" });

    for (const value of [
      { stdout: { regex: '"ok":\\s*true' } },
      { stdout: "a\nb", stderr: { regex: "done" } },
      { stdout: { regex: "ok", not: { regex: "boom" } } },
      { regex: "x" },
      { anyOf: ["a", "b"] },
      { exitCode: 2 },
      { stdout: { arbitrary: "x" }, nested: { arrays: [true, null, -2] } },
    ]) {
      expect(verify(JSON.stringify(value))).toBe(`expect: command \`c\` \`expect=${JSON.stringify(value)}\``);
    }
    expect(() => verify("{ stdout: makeMatcher() }")).toThrow("Unsupported literal prop <Verify>.expect");
  });

  test("fails loudly on a Run without a command", () => {
    expect(() => serializeDocsPage("Text\n\n<Run expectExit={1} />\n", { file: "/x/run.mdx" })).toThrow(
      "<Run> without a command in /x/run.mdx:3",
    );
  });

  test("fails loudly on a missing fixture", () => {
    expect(() =>
      serializeDocsPage('<UseFixture name="nope" />\n', { file: "/x/f.mdx", fixtureRoots: [] }),
    ).toThrow('Fixture "nope" not found');
  });

  test("traverses HTML and fragments without leaking hidden descendants", () => {
    const out = serializeDocsPage('<div><span>public<Hidden reason="test">private</Hidden></span></div>', {
      file: "/x/v.mdx",
    });
    expect(out).toContain("public");
    expect(out).not.toContain("private");
    for (const source of [
      "<div><Mystery /></div>",
      "<><span><Mystery /></span></>",
      "<div><script>bad()</script></div>",
    ])
      expect(() => serializeDocsPage(source, { file: "/x/v.mdx" })).toThrow(LlmsSerializeError);
    expect(serializeDocsPage("<div render={false}><Mystery /></div>", { file: "/x/v.mdx" })).toBe("");
  });

  test("uses visible scenario and tab variables without leaking across scopes", () => {
    const source = `---
id: scoped-bindings
provider: test
tabs: [one, two]
---

<Guide>
<Scenario id="a"><Tabs>
<Tab name="one"><Step name="one"><Variable name="app" value="runtime-one" display="public-one" /><Run command="echo {{app}}" /></Step></Tab>
<Tab name="two"><Step name="two"><Variable name="app" value="runtime-two" display="public-two" /><Verify command="echo {{app}}" expect="{{app}}" /></Step></Tab>
</Tabs></Scenario>
<Scenario id="b"><Step name="other"><Variable name="app" value="runtime-b" display="public-b" /><Run command="echo {{app}}" /></Step></Scenario>
</Guide>`;
    const out = serializeDocsPage(source, { file: "/x/v.mdx" });
    expect(out).toContain("echo public-one");
    expect(out).toContain('expect: command `echo public-two` `expect="{{app}}"`');
    expect(out).toContain("echo public-b");
    expect(out).not.toContain("runtime-");
    expect(out).not.toContain("echo {{app}}");
    for (const hidden of [false, true]) {
      expect(() =>
        serializeDocsPage(
          `---\nid: hidden-reference\nprovider: test\n---\n\n<Guide>\n${hidden ? '<Scenario id="hidden" render={false} reason="Internal regression"><Step name="binding"><Variable name="private" value="excluded" /><Run command="echo {{private}}" /></Step></Scenario>' : '<Scenario id="public"><Hidden reason="Private setup"><Step name="binding"><Variable name="private" value="excluded" /><Run command="echo {{private}}" /></Step></Hidden><Step name="action"><Run command="echo {{private}}" /></Step></Scenario>'}\n${hidden ? '<Scenario id="public"><Step name="action"><Run command="echo {{private}}" /></Step></Scenario>' : ""}\n</Guide>`,
          { file: "/x/v.mdx" },
        ),
      ).toThrow(hidden ? "guide.variable.missing" : "guide.variable.hidden-reference");
    }
  });

  test("substitutes real Drupal CMS commands with each scenario's display value", async () => {
    const out = await serializeFile(resolve(repoRoot, "recipes/drupal-cms/README.mdx"), "drupal-cms");
    expect(out).toContain("lando init --recipe drupal-cms --name=my-drupal-cms-app --yes");
    expect(out).toContain("lando init --recipe drupal-cms --name=my-drupal-cms-nginx --yes");
    expect(out).not.toContain("{{appName}}");
  });

  test("preserves literal templates in expectations, event/error targets, shell, and library code", () => {
    const expectation = { stdout: { equals: "{{token}}", regex: "{{missing}}" }, values: ["{{token}}"] };
    for (const declaration of ["", '<Variable name="token" value="runtime" display="public" />']) {
      const out = serializeDocsPage(
        `${declaration}

<Verify command="echo" expect={${JSON.stringify(expectation)}} />
<Verify event="{{token}}" expect="{{token}}" />
<Verify errorTag="{{token}}" />
<Run shell="echo {{token}}" />
<Run runtime="library" code="const value = '{{token}}';" />
<Run runtime="library" code="ignored" displayCode="const shown = '{{token}}';" />`,
        { file: "/x/literal.mdx" },
      );
      expect(out).toContain(`expect=${JSON.stringify(expectation)}`);
      expect(out).toContain('expect: event `{{token}}` `expect="{{token}}"`');
      expect(out).toContain("expect: error `{{token}}`");
      expect(out).toContain("```sh\necho {{token}}\n```");
      expect(out).toContain("```ts\nconst value = '{{token}}';\n```");
      expect(out).toContain("```ts\nconst shown = '{{token}}';\n```");
    }
    const out = serializeDocsPage(
      '---\nid: literal-target\nprovider: test\n---\n\n<Guide><Scenario id="reader"><Step name="target"><Variable name="token" value="runtime" display="public" /><Verify file="{{token}}.txt" expect="{{token}}" /></Step></Scenario></Guide>',
      { file: "/x/target.mdx" },
    );
    expect(out).toContain('expect: file `public.txt` `expect="{{token}}"`');
  });

  test("preserves current-main conflict, stop-marker, and plugin-manifest fixtures", async () => {
    const landofile = await serializeFile(
      resolve(docsRoot, "guides/landofile/your-landofile.mdx"),
      "your-landofile",
    );
    expect(landofile).toContain("Fixture `dual-form-conflict`, `.lando.yml`:");
    expect(landofile).toContain("Fixture `dual-form-conflict`, `.lando.ts`:");
    expect(landofile).toContain("Fixture `discovery-stop-marker`, `.lando.stop`:");
    const plugin = await serializeFile(
      resolve(docsRoot, "guides/plugins/link-local-plugin.mdx"),
      "link-local-plugin",
    );
    expect(plugin).toContain("Fixture `excess-manifest-key`, `package.json`:");
  });

  test("decodes static escaped strings and preserves explicit exit expectations", () => {
    const out = serializeDocsPage(
      String.raw`<Run command={'printf "hello\\world"\nnext'} expectExit={2} />
<Verify command={\`echo \\path\`} expectExit={1} expect={{ stdout: { regex: "a\\nb" } }} />`.replaceAll(
        "\\`",
        "`",
      ),
      { file: "/x/v.mdx" },
    );
    expect(out).toContain('printf "hello\\world"\nnext');
    expect(out).toContain("expectExit=2");
    expect(out).toContain("expectExit=1");
    expect(out).toContain("echo \\path");
    expect(out).toContain(JSON.stringify({ stdout: { regex: "a\\nb" } }));
    for (const source of [
      "<Run command={run()} />",
      "<Run command={`echo ${value}`} />",
      "<Run {...props} />",
      '<Run command="echo" expectExit={1e309} />',
    ])
      expect(() => serializeDocsPage(source, { file: "/x/v.mdx" })).toThrow(LlmsSerializeError);
  });

  test("rejects absolute and traversing fixture names and guide ids", () => {
    for (const value of ["../outside", "/outside", "C:\\outside", "a/../../outside", "..\\outside"]) {
      expect(() => fixtureRootsFor(docsRoot, { id: value })).toThrow(LlmsSerializeError);
      expect(() =>
        serializeDocsPage(`<UseFixture name={${JSON.stringify(value)}} />`, {
          file: "/x/v.mdx",
          fixtureRoots: [docsRoot],
        }),
      ).toThrow(LlmsSerializeError);
    }
  });

  test("rejects fixture, root, and built-file symlink escapes using isolated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "llms-containment-"));
    try {
      const allowed = join(root, "allowed");
      const outside = join(root, "outside");
      await mkdir(allowed);
      await mkdir(outside);
      await writeFile(join(outside, ".lando.yml"), "name: isolated-fixture\n");
      await symlink(outside, join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir");
      expect(() =>
        serializeDocsPage('<UseFixture name="escape" />', { file: "/x/v.mdx", fixtureRoots: [allowed] }),
      ).toThrow("symlink");
      await mkdir(join(allowed, "direct"));
      await symlink(join(outside, ".lando.yml"), join(allowed, "direct", ".lando.yml"), "file");
      expect(() =>
        serializeDocsPage('<UseFixture name="direct" />', { file: "/x/v.mdx", fixtureRoots: [allowed] }),
      ).toThrow("symlink");
      await symlink(outside, join(allowed, "guides"), process.platform === "win32" ? "junction" : "dir");
      expect(() => fixtureRootsFor(allowed, { id: "demo" })).toThrow("symlink");
      expect(() => builtFileFor(`${site}${base}escape/.lando.yml`, base, site, allowed)).toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("contains decoded built links beneath the output root", () => {
    const root = resolve(docsRoot, "dist");
    expect(builtFileFor(`${site}${base}guides/demo/`, base, site, root)).toBe(
      resolve(root, "guides/demo/index.html"),
    );
    for (const path of [
      "%2foutside",
      "%2e%2e%2foutside",
      "a%2f..%2f..%2foutside",
      "%5coutside",
      "%00bad",
      "%zz",
    ]) {
      expect(() => builtFileFor(`${site}${base}${path}`, base, site, root)).toThrow(LlmsSerializeError);
    }
    expect(() => builtFileFor(`https://example.com${base}a`, base, site, root)).toThrow(LlmsSerializeError);
  });

  test.each(["llms.txt", "llms-full.txt"])(
    "refuses a dangling %s output symlink before writing either output",
    async (output) => {
      const root = await mkdtemp(join(tmpdir(), "llms-output-containment-"));
      try {
        const outDir = join(root, "output");
        const outside = join(root, "outside.txt");
        await mkdir(outDir);
        await symlink(outside, join(outDir, output), "file");
        const inventory: SourceLinkInventory = {
          repoRoot: root,
          base,
          pages: new Map(),
          files: new Set(),
          directories: new Set(),
          schemas: new Map(),
        };
        await expect(writeLlmsFiles(inventory, site, outDir)).rejects.toThrow("output symlink");
        expect(existsSync(outside)).toBe(false);
        const other = output === "llms.txt" ? "llms-full.txt" : "llms.txt";
        expect(existsSync(join(outDir, other))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("llms.txt", async () => {
  const inventory = await createSourceLinkInventory(repoRoot, base);
  const pages = await collectLlmsPages(inventory, site);

  test("every link in llms-full.txt is absolute", () => {
    const full = renderLlmsFull(pages);
    const bad = [...full.matchAll(/\]\(([^)\s]*)/g)]
      .map((match) => match[1] ?? "")
      .filter((url) => !/^(?:https?|mailto):/.test(url) && !url.startsWith("#"));

    expect(bad).toEqual([]);
    expect(full).toContain(`](${site}${base}`);
  });

  test("leaves schema reference pages out of llms-full.txt but indexes them", () => {
    const full = renderLlmsFull(pages);
    const index = renderLlmsIndex(pages, inventory, site);
    const schemaPages = pages.filter((page) => page.id.startsWith("reference/schemas/"));

    expect(index).toContain("the documentation in one file, excluding generated schema reference pages.");
    expect(schemaPages.length).toBeGreaterThan(0);
    for (const page of schemaPages) {
      expect(full).not.toContain(`Source: ${page.url}\n`);
      expect(index).toContain(`](${page.url})`);
    }
  });

  test("every URL resolves under the /core4/ base path", async () => {
    const index = renderLlmsIndex(pages, inventory, site);
    const routes = new Set([...inventory.pages.values()].map((id) => routeFor(base, id)));
    const urls = llmsIndexUrls(index);

    expect(urls.length).toBeGreaterThan(pages.length);
    expect(urls).toContain(`${site}${base}reference/commands/`);
    expect(urls).toContain(`${site}${base}schemas/landofile.schema.json`);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(site);
      expect(parsed.pathname.startsWith(base)).toBe(true);
      const path = decodeURIComponent(parsed.pathname.slice(base.length));
      const resolvable =
        routes.has(parsed.pathname) ||
        path === "llms-full.txt" ||
        existsSync(resolve(docsRoot, "public", path)) ||
        [...inventory.schemas.values()].includes(path);
      expect({ url, resolvable }).toEqual({ url, resolvable: true });
    }
  });
});
