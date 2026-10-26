import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { VFile } from "vfile";

import {
  type SourceLinkInventory,
  createSourceLinkInventory,
  docsPageId,
  publishSchemaAssets,
  resolveSourceLink,
} from "../src/lib/source-links.ts";
import { remarkSourceLinks } from "../src/plugins/remark-source-links.ts";

const root = resolve(tmpdir(), "lando-source-link-unit");
const path = (value: string): string => resolve(root, value);
const inventory: SourceLinkInventory = {
  repoRoot: root,
  base: "/core4/",
  pages: new Map([
    [path("docs/embedding.md"), "embedding"],
    [path("docs/guides/library/embedding-runtime.mdx"), "guides/library/embedding-runtime"],
    [path("docs/guides/setup/provider-selection.mdx"), "guides/setup/provider-selection"],
    [path("recipes/lamp/README.mdx"), "recipes/lamp"],
    [path("docs/index.md"), "index"],
  ]),
  files: new Set([path("core/src/index.ts"), path("docs/guides/INDEX.md")]),
  directories: new Set([path("core/src")]),
  schemas: new Map([[path("dist/schemas/global-config.json"), "schemas/global-config.json"]]),
};
const from = (url: string, source = "docs/embedding.md", data = inventory): string =>
  resolveSourceLink(url, path(source), data);

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("source links", () => {
  test("resolves source paths rather than browser directories and preserves suffixes", () => {
    // Given a root document and nested guide, when links render, then source-relative destinations retain their query and anchor.
    expect(from("./guides/library/embedding-runtime.mdx?view=all#supply-global-config")).toBe(
      "/core4/guides/library/embedding-runtime/?view=all#supply-global-config",
    );
    expect(
      from("../setup/provider-selection.mdx#what-persists", "docs/guides/library/embedding-runtime.mdx"),
    ).toBe("/core4/guides/setup/provider-selection/#what-persists");
  });

  test("uses recipe routes, index routes, and the configured base once", () => {
    // Given explicit recipe and index IDs, when resolving both directions, then README and index do not leak into routes.
    expect(from("../recipes/lamp/README.mdx")).toBe("/core4/recipes/lamp/");
    expect(from("../../docs/embedding.md", "recipes/lamp/README.mdx")).toBe("/core4/embedding/");
    expect(from("./index.md")).toBe("/core4/");
    expect(from("/embedding#entry-points")).toBe("/core4/embedding/#entry-points");
    expect(from("/core4/embedding/#entry-points")).toBe("/core4/embedding/#entry-points");
    expect(
      from("./guides/library/embedding-runtime.mdx", "docs/embedding.md", { ...inventory, base: "/" }),
    ).toBe("/guides/library/embedding-runtime/");
  });

  test("maps only known repository sources and published schema assets", () => {
    // Given a tracked nonpage, directory, and generated schema, when linked, then each uses its real publication destination.
    expect(from("../core/src/index.ts#L1")).toBe(
      "https://github.com/AaronFeledy/core4/blob/main/core/src/index.ts#L1",
    );
    expect(from("../core/src/")).toBe("https://github.com/AaronFeledy/core4/tree/main/core/src");
    expect(from("./guides/INDEX.md")).toBe(
      "https://github.com/AaronFeledy/core4/blob/main/docs/guides/INDEX.md",
    );
    expect(
      from("../../../dist/schemas/global-config.json?download=1", "docs/reference/schemas/global-config.mdx"),
    ).toBe("/core4/schemas/global-config.json?download=1");
  });

  test("does not disguise unknown destinations or rewrite external URLs", () => {
    // Given unsupported or missing targets, when normalizing, then validation still sees the original links.
    for (const url of [
      "https://example.com/a.md",
      "mailto:test@example.com",
      "tel:123",
      "//example.com/a",
      "#missing-anchor",
      "?tab=1",
      "/unknown/",
      "./missing.mdx",
      "../dist/private.json",
      "../../outside.md",
      "./bad%ZZ.md",
      "./%2e%2e/%2e%2e/outside.md",
    ])
      expect(from(url)).toBe(url);
    expect(resolveSourceLink("./embedding.md", resolve(root, "../outside.md"), inventory)).toBe(
      "./embedding.md",
    );
  });

  test("uses Astro-compatible default IDs and authored slugs", () => {
    // Given filenames and metadata, when deriving IDs, then capitalization, nested index, and overrides match glob loading.
    expect(docsPageId("Guides/Hello World.mdx", {})).toBe("guides/hello-world");
    expect(docsPageId("guides/index.mdx", {})).toBe("guides");
    expect(docsPageId("index.md", {})).toBe("index");
    expect(docsPageId("guide.mdx", { slug: "custom/route" })).toBe("custom/route");
  });

  test("transforms Markdown links and definitions but not image or code URLs", () => {
    // Given Markdown references and inert text, when the remark plugin runs, then only navigational links change.
    const tree = fromMarkdown(
      "[Guide](./guides/library/embedding-runtime.mdx)\n\n[Again][g]\n\n[g]: ./guides/library/embedding-runtime.mdx#section\n\n![Image](./guides/library/embedding-runtime.mdx)\n\n`./guides/library/embedding-runtime.mdx`",
    );
    remarkSourceLinks(inventory)(tree, new VFile({ path: path("docs/embedding.md") }));
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('"url":"/core4/guides/library/embedding-runtime/"');
    expect(serialized).toContain('"url":"/core4/guides/library/embedding-runtime/#section"');
    expect(serialized).toContain('"url":"./guides/library/embedding-runtime.mdx"');
  });

  test("inventories actual source files and publishes generated schema bytes without replacing editor schemas", async () => {
    // Given a miniature checkout with generated artifacts, when inventoried and published, then only real pages and assets get routes.
    const directory = await mkdtemp(resolve(tmpdir(), "lando-doc-links-"));
    temporary.push(directory);
    const put = async (name: string, content: string): Promise<void> => {
      const target = resolve(directory, name);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content);
    };
    await put("docs/embedding.md", "# Embedding\n");
    await put("docs/guides/example.mdx", "---\nslug: custom/example\n---\n# Example\n");
    await put("docs/guides/INDEX.md", "# Not published\n");
    await put("recipes/lamp/README.mdx", "# Recipe\n");
    await put("output/schemas/global-config.schema.json", "editor bytes\n");
    for (const command of [
      ["git", "init", "--quiet"],
      ["git", "add", "docs", "recipes"],
    ]) {
      const result = Bun.spawnSync(command, { cwd: directory });
      expect(result.exitCode).toBe(0);
    }
    const clean = await createSourceLinkInventory(directory, "/core4/");
    expect(clean.schemas.size).toBe(0);
    await put("dist/schemas/global-config.json", '{"type":"object"}\n');
    const actual = await createSourceLinkInventory(directory, "/core4/");
    expect(actual.pages.get(resolve(directory, "docs/guides/example.mdx"))).toBe("custom/example");
    expect(actual.pages.has(resolve(directory, "docs/guides/INDEX.md"))).toBe(false);
    expect(actual.pages.get(resolve(directory, "recipes/lamp/README.mdx"))).toBe("recipes/lamp");
    await publishSchemaAssets(actual, resolve(directory, "output"));
    expect(await readFile(resolve(directory, "output/schemas/global-config.json"), "utf8")).toBe(
      '{"type":"object"}\n',
    );
    expect(await readFile(resolve(directory, "output/schemas/global-config.schema.json"), "utf8")).toBe(
      "editor bytes\n",
    );
    const collision = {
      ...actual,
      schemas: new Map([
        [resolve(directory, "dist/schemas/global-config.json"), "schemas/global-config.schema.json"],
      ]),
    };
    await expect(publishSchemaAssets(collision, resolve(directory, "output"))).rejects.toThrow("collides");
    expect(await readFile(resolve(directory, "output/schemas/global-config.schema.json"), "utf8")).toBe(
      "editor bytes\n",
    );
  });
});
