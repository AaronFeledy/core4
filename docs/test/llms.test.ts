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
} from "../src/lib/llms.ts";
import { createSourceLinkInventory } from "../src/lib/source-links.ts";

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
      "# Title",
      "",
      'Use <Variable name="app" value="my-app" display="demo" /> here.',
      "",
      "<Guide>",
      '  <Scenario id="a">',
      '    <Step name="s">',
      '      <Run command="lando start" />',
      '      <Run runtime="library" code="x" displayCode="const y = 1;" />',
      '      <Verify command="lando info" expect="ok" />',
      "      <Verify />",
      '      <Inline code="echo hi" lang="sh" justification="demo" />',
      '      <Hidden reason="r"><Run command="secret-hidden" /></Hidden>',
      '      <Skip reason="r"><Run command="secret-skip" /></Skip>',
      "      <Cleanup />",
      "    </Step>",
      "  </Scenario>",
      '  <Scenario id="b" render={false}><Step name="t"><Run command="secret-unrendered" /></Step></Scenario>',
      "</Guide>",
    ].join("\n");

    const out = serializeDocsPage(source, { file: "/x/guide.mdx" });

    expect(out).toContain("Use `demo` here.");
    expect(out).toContain("```sh\nlando start\n```");
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
    expect(() => verify("{ stdout: makeMatcher() }")).toThrow("Unsupported static prop expect");
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
    const source = `<Guide>
<Scenario id="a">
<Run command="echo {{app}}" />
<Step name="a"><Variable name="app" value="runtime" display="public-a" /></Step>
<Tabs><Tab name="one"><Variable name="app" value="one" /><Run command="echo {{app}}" /></Tab>
<Tab name="two"><Variable name="app" value="two" /><Verify command="echo {{app}}" expect="{{app}}" /></Tab></Tabs>
<Run command="echo {{app}}" />
</Scenario>
<Scenario id="b"><Variable name="app" value="public-b" /><Run command="echo {{app}}" /></Scenario>
</Guide>`;
    const out = serializeDocsPage(source, { file: "/x/v.mdx" });
    expect(out.match(/echo public-a/g)).toHaveLength(2);
    expect(out).toContain("echo one");
    expect(out).toContain('expect: command `echo two` `expect="two"`');
    expect(out).toContain("echo public-b");
    expect(out).not.toContain("runtime");
    expect(out).not.toContain("{{app}}");
    for (const hidden of [
      '<Hidden><Variable name="private" value="excluded" /></Hidden>',
      '<Scenario id="hidden" render={false}><Variable name="private" value="excluded" /></Scenario>',
    ]) {
      expect(() =>
        serializeDocsPage(
          `${hidden}\n\n<Scenario id="public"><Run command="echo {{private}}" /></Scenario>`,
          { file: "/x/v.mdx" },
        ),
      ).toThrow("Unresolved public variable private");
    }
  });

  test("substitutes real Drupal CMS commands with each scenario's display value", async () => {
    const out = await serializeFile(resolve(repoRoot, "recipes/drupal-cms/README.mdx"), "drupal-cms");
    expect(out).toContain("lando init --recipe drupal-cms --name=my-drupal-cms-app --yes");
    expect(out).toContain("lando init --recipe drupal-cms --name=my-drupal-cms-nginx --yes");
    expect(out).not.toContain("{{appName}}");
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
