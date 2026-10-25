import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LlmsSerializeError,
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
      'expect: command `lando app:config:lint --format=json` stdout matches `"valid":\\s*true`',
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
    expect(out).toContain("expect: command `lando info` output equals `ok`");
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

  test("parses Verify expectations into stream and pattern", () => {
    const verify = (expect: string): string =>
      serializeDocsPage(`<Verify command="c" expect={${expect}} />\n`, { file: "/x/v.mdx" });

    expect(verify('{ stdout: { regex: "\\"ok\\":\\\\s*true" } }')).toBe(
      'expect: command `c` stdout matches `"ok":\\s*true`',
    );
    expect(verify('{ stdout: "a\\nb", stderr: { regex: "done" } }')).toBe(
      "expect: command `c` stdout equals `a\\nb`, stderr matches `done`",
    );
    expect(verify('{ stdout: { not: { regex: "boom" } } }')).toBe(
      "expect: command `c` stdout not matches `boom`",
    );
    expect(verify('{ regex: "x" }')).toBe("expect: command `c` output matches `x`");
    expect(verify('{ anyOf: ["a", "b"] }')).toBe("expect: command `c` output is one of `a` or `b`");
    expect(verify("{ exitCode: 2 }")).toBe("expect: command `c` exitCode is `2`");
    // Unknown shapes fall back to the raw expression.
    expect(verify("{ stdout: makeMatcher() }")).toBe(
      "expect: command `c` matches `{ stdout: makeMatcher() }`",
    );
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
