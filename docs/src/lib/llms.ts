import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { projectGuidePresentation, propsOf as staticPropsOf } from "@lando/core/docs/guide-compiler";

import { GuideId } from "@lando/sdk/docs/components";
import { Schema } from "effect";
import type { Code, Html, InlineCode, Nodes, Paragraph, Parents, Root, RootContent, Strong } from "mdast";
import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { VFile } from "vfile";
import { parse as parseYaml } from "yaml";

import { guideComponentVocabulary } from "../components/vocabulary.ts";
import { remarkSourceLinks } from "../plugins/remark-source-links.ts";
import { escapeReferenceMdxPlaceholders } from "../reference-mdx.ts";
import type { SourceLinkInventory } from "./source-links.ts";
import { normalizeContentMetadata } from "./titles.ts";

type JsxElement = MdxJsxFlowElement | MdxJsxTextElement;
type PropValue = unknown;

export type SerializeOptions = {
  /** Absolute path of the source file, used for errors and fixture lookup. */
  readonly file: string;
  /** Directories searched, in order, for `<UseFixture name>` fixtures. */
  readonly fixtureRoots?: readonly string[];
  /** When set, links are rewritten like the site does and made absolute against `site`. */
  readonly links?: {
    readonly inventory: SourceLinkInventory;
    readonly site: string;
    readonly pageUrl: string;
  };
};

export class LlmsSerializeError extends Error {
  override readonly name = "LlmsSerializeError";
}

const KNOWN_COMPONENTS = new Set(Object.keys(guideComponentVocabulary));
const DROPPED = new Set(["Hidden", "Skip", "Cleanup", "Inspect"]);
const UNWRAPPED = new Set(["Guide", "Scenario", "Step", "Tabs"]);

const FRONTMATTER = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/;

const frontmatterOf = (source: string): Record<string, unknown> => {
  const block = FRONTMATTER.exec(source)?.[1];
  const data: unknown = block === undefined ? {} : parseYaml(block);
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
};

const propsOf = (node: JsxElement, file: string): Map<string, PropValue> => {
  try {
    return new Map(Object.entries(staticPropsOf(node, file)));
  } catch (error) {
    throw new LlmsSerializeError(
      `Unsupported static prop on <${node.name}> in ${at(node, file)}: ${String(error)}`,
    );
  }
};
const text = (value: PropValue): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;
const isFalse = (value: PropValue): boolean => value === false;

const at = (node: Nodes, file: string): string =>
  node.position === undefined ? file : `${file}:${node.position.start.line}`;

const fence = (lang: string, value: string): Code => ({
  type: "code",
  lang,
  value: value.replace(/\n$/, ""),
});
const paragraph = (...children: Paragraph["children"]): Paragraph => ({ type: "paragraph", children });
const code = (value: string): InlineCode => ({ type: "inlineCode", value });

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const containedPath = (root: string, candidate: string): string => {
  if (!within(root, candidate)) throw new LlmsSerializeError("Path escapes allowed root");
  // Check the nearest existing ancestor too: an absent file may sit beneath a symlink.
  let ancestor = candidate;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  let rootAncestor = root;
  while (!existsSync(rootAncestor) && dirname(rootAncestor) !== rootAncestor)
    rootAncestor = dirname(rootAncestor);
  if (!within(realpathSync(rootAncestor), realpathSync(ancestor)))
    throw new LlmsSerializeError("Path escapes allowed root through a symlink");
  return candidate;
};

const fixtureNodes = (name: string, options: SerializeOptions, node: Nodes): RootContent[] => {
  if (!Schema.is(GuideId)(name))
    throw new LlmsSerializeError(`Invalid fixture name in ${at(node, options.file)}`);
  for (const root of options.fixtureRoots ?? []) {
    const directory = containedPath(root, resolve(root, name));
    if (!existsSync(directory)) continue;
    const nodes: RootContent[] = [];
    for (const candidate of [".lando.yml", "recipe.yml", ".lando.ts", ".lando.stop", "package.json"]) {
      const path = containedPath(root, resolve(directory, candidate));
      if (!existsSync(path)) continue;
      nodes.push(
        paragraph(
          { type: "text", value: "Fixture " },
          code(name),
          { type: "text", value: ", " },
          code(candidate),
          {
            type: "text",
            value: ":",
          },
        ),
        fence(
          candidate.endsWith(".ts")
            ? "ts"
            : candidate.endsWith(".stop")
              ? "text"
              : candidate.endsWith(".json")
                ? "json"
                : "yaml",
          readFileSync(path, "utf8"),
        ),
      );
    }
    if (nodes.length > 0) return nodes;
    throw new LlmsSerializeError(
      `Fixture "${name}" has no static Landofile, stop marker, or package manifest (${relative(process.cwd(), directory)}) in ${at(node, options.file)}`,
    );
  }
  throw new LlmsSerializeError(`Fixture "${name}" not found for <UseFixture> in ${at(node, options.file)}`);
};

const exitNodes = (props: Map<string, PropValue>): Paragraph[] => {
  const exit = text(props.get("expectExit"));
  if (exit === undefined) return [];
  if (!/^-?\d+$/.test(exit)) throw new LlmsSerializeError("Expected a static integer expectExit");
  return [paragraph(code(`expectExit=${exit}`))];
};

const verifyNodes = (props: Map<string, PropValue>): RootContent[] => {
  const target = ["command", "event", "file", "errorTag"]
    .map((key) => [key === "errorTag" ? "error" : key, text(props.get(key))] as const)
    .find((entry) => entry[1] !== undefined);
  const expect = props.get("expect");
  if (target === undefined && expect === undefined) return exitNodes(props);
  const children: Paragraph["children"] = [{ type: "text", value: "expect: " }];
  if (target !== undefined) children.push({ type: "text", value: `${target[0]} ` }, code(target[1] ?? ""));
  if (expect === undefined) return [paragraph(...children), ...exitNodes(props)];
  const expectation = expect;
  children.push(
    { type: "text", value: target === undefined ? "" : " " },
    code(`expect=${JSON.stringify(expectation)}`),
  );
  return [paragraph(...children), ...exitNodes(props)];
};

/** Replace one guide component with plain markdown nodes. */
const replaceComponent = (node: JsxElement, options: SerializeOptions, source: string): RootContent[] => {
  const name = node.name;
  if (name === null || name === undefined)
    return transformChildren(node, options, source).children as RootContent[];
  if (!KNOWN_COMPONENTS.has(name) && !/^[a-z]/.test(name)) {
    throw new LlmsSerializeError(`Unknown MDX component <${name}> in ${at(node, options.file)}`);
  }
  const props = propsOf(node, options.file);
  if (isFalse(props.get("render")) || DROPPED.has(name)) return [];
  if (/^[a-z]/.test(name)) {
    if (["br", "hr"].includes(name)) return [{ type: "html", value: `<${name}>` } satisfies Html];
    if (!["div", "span", "section", "article", "details", "summary", "p", "kbd", "sup", "sub"].includes(name))
      throw new LlmsSerializeError(`Unsupported HTML element <${name}> in ${at(node, options.file)}`);
    return transformChildren(node, options, source).children as RootContent[];
  }
  if (UNWRAPPED.has(name)) return transformChildren(node, options, source).children as RootContent[];
  switch (name) {
    case "Run": {
      const displayCode = text(props.get("displayCode"));
      const commandProp = text(props.get("command"));
      const command = displayCode ?? commandProp ?? text(props.get("shell")) ?? text(props.get("code"));
      if (command === undefined || command.trim() === "")
        throw new LlmsSerializeError(`<Run> without a command in ${at(node, options.file)}`);
      const library = text(props.get("runtime")) === "library";
      return [fence(library ? "ts" : "sh", command), ...exitNodes(props)];
    }
    case "Verify":
      return verifyNodes(props);
    case "Inline":
      return [fence(text(props.get("lang")) ?? "ts", text(props.get("code")) ?? "")];
    case "Variable": {
      const value = code(text(props.get("display")) ?? text(props.get("value")) ?? "");
      return [node.type === "mdxJsxFlowElement" ? paragraph(value) : (value as RootContent)];
    }
    case "UseFixture": {
      const fixture = text(props.get("name"));
      if (fixture === undefined)
        throw new LlmsSerializeError(`<UseFixture> without a name in ${at(node, options.file)}`);
      return fixtureNodes(fixture, options, node);
    }
    case "Tab": {
      const label: Strong = {
        type: "strong",
        children: [{ type: "text", value: text(props.get("name")) ?? "" }],
      };
      return [paragraph(label), ...(transformChildren(node, options, source).children as RootContent[])];
    }
    default:
      throw new LlmsSerializeError(`No llms serialization for <${name}> in ${at(node, options.file)}`);
  }
};

const isComment = (value: string): boolean => /^\s*\/\*[\s\S]*\*\/\s*$/.test(value);

function transformChildren<T extends Parents>(parent: T, options: SerializeOptions, source: string): T {
  const next: Nodes[] = [];
  for (const child of parent.children as Nodes[]) {
    switch (child.type) {
      case "yaml":
      case "mdxjsEsm":
        break;
      case "mdxFlowExpression":
      case "mdxTextExpression":
        if (!isComment(child.value)) {
          throw new LlmsSerializeError(
            `Unsupported MDX expression {${child.value.trim()}} in ${at(child, options.file)}`,
          );
        }
        break;
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        next.push(...replaceComponent(child, options, source));
        break;
      default:
        if (child.type === "paragraph") {
          const transformed = transformChildren(child, options, source);
          let inline: Paragraph["children"] = [];
          const flush = (): void => {
            if (inline.length > 0) next.push(paragraph(...inline));
            inline = [];
          };
          for (const node of transformed.children as Nodes[]) {
            if (["code", "paragraph"].includes(node.type)) {
              flush();
              next.push(node);
            } else inline.push(node as Paragraph["children"][number]);
          }
          flush();
        } else next.push("children" in child ? transformChildren(child, options, source) : child);
    }
  }
  return { ...parent, children: next } as T;
}

const absolutizeLinks = (tree: Root, file: string, links: NonNullable<SerializeOptions["links"]>): void => {
  remarkSourceLinks(links.inventory)(tree, new VFile({ path: file }));
  const visit = (node: Nodes): void => {
    if (node.type === "link" || node.type === "definition") {
      // Whatever the source rewrite leaves is browser-relative, so resolve it the way the page would.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(node.url)) node.url = new URL(node.url, links.pageUrl).href;
    }
    if ("children" in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(tree);
};

const dropLeadingHeading = (tree: Root): Root => {
  const first = tree.children[0];
  return first?.type === "heading" && first.depth === 1
    ? { ...tree, children: tree.children.slice(1) }
    : tree;
};

const stringify = (tree: Root): string =>
  unified()
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true, rule: "-" })
    .stringify(tree)
    .trim();

/**
 * Serialize one docs page (Markdown or guide MDX) to plain Markdown for llms-full.txt.
 * Fails loudly on any component it does not know how to flatten.
 */
export const serializeDocsPage = (source: string, options: SerializeOptions): string => {
  const isMdx = options.file.endsWith(".mdx");
  const input = /\/docs\/reference\/.*\.mdx$/.test(options.file.replaceAll("\\", "/"))
    ? escapeReferenceMdxPlaceholders(source)
    : source;
  const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
  if (isMdx) processor.use(remarkMdx);
  const tree = processor.parse(input) as Root;
  projectGuidePresentation(options.file, tree);
  const out = dropLeadingHeading(transformChildren(tree, options, input));
  if (options.links !== undefined) absolutizeLinks(out, options.file, options.links);
  return stringify(out);
};

export const fixtureRootsFor = (docsRoot: string, frontmatter: Record<string, unknown>): string[] => {
  const id = typeof frontmatter.id === "string" ? frontmatter.id : undefined;
  if (id !== undefined && !Schema.is(GuideId)(id)) throw new LlmsSerializeError("Invalid guide fixture id");
  return [
    ...(id === undefined ? [] : [containedPath(docsRoot, resolve(docsRoot, "guides", id, "fixtures"))]),
    containedPath(docsRoot, resolve(docsRoot, "guides", "fixtures")),
  ];
};

export type LlmsPage = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly body: string;
};

const SECTIONS: readonly (readonly [string, string])[] = [
  ["guides/", "Guides"],
  ["recipes/", "Recipes"],
  ["reference/", "Reference"],
];

const sectionOf = (id: string): string =>
  SECTIONS.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "Overview";

export const routeFor = (base: string, id: string): string => (id === "index" ? base : `${base}${id}/`);

export const collectLlmsPages = async (inventory: SourceLinkInventory, site: string): Promise<LlmsPage[]> => {
  const docsRoot = resolve(inventory.repoRoot, "docs");
  const pages: LlmsPage[] = [];
  for (const [file, id] of inventory.pages) {
    const source = await readFile(file, "utf8");
    const frontmatter = frontmatterOf(source);
    const meta = normalizeContentMetadata(frontmatter, source, id);
    const url = new URL(routeFor(inventory.base, id), site).href;
    pages.push({
      id,
      url,
      title: String(meta.title),
      description: typeof meta.description === "string" ? meta.description : undefined,
      body: serializeDocsPage(source, {
        file,
        fixtureRoots: fixtureRootsFor(docsRoot, frontmatter),
        links: { inventory, site, pageUrl: url },
      }),
    });
  }
  return pages.sort((left, right) =>
    left.id === "index" ? -1 : right.id === "index" ? 1 : left.id.localeCompare(right.id),
  );
};

export const renderLlmsIndex = (
  pages: readonly LlmsPage[],
  inventory: SourceLinkInventory,
  site: string,
): string => {
  const url = (path: string): string => new URL(`${inventory.base}${path}`, site).href;
  const lines = [
    "# Lando",
    "",
    "> Lando 4 (Core4) documentation: install, configure Landofiles, run services, and script the CLI.",
    "",
    "## Machine-readable references",
    "",
    `- [Full documentation as plain Markdown](${url("llms-full.txt")}): the documentation in one file, excluding generated schema reference pages.`,
    `- [CLI command reference](${url("reference/commands/")}): every lando command, its flags, and output.`,
    `- [Landofile JSON schema](${url("schemas/landofile.schema.json")}): validates .lando.yml files.`,
    `- [Global config JSON schema](${url("schemas/global-config.schema.json")}): validates the global Lando config.`,
  ];
  for (const section of ["Overview", ...SECTIONS.map(([, label]) => label)]) {
    const entries = pages.filter((page) => sectionOf(page.id) === section);
    if (entries.length === 0) continue;
    lines.push("", `## ${section}`, "");
    for (const page of entries)
      lines.push(
        `- [${page.title}](${page.url})${page.description === undefined ? "" : `: ${page.description}`}`,
      );
  }
  return `${lines.join("\n")}\n`;
};

// Schema reference pages restate the JSON schemas that llms.txt already links.
export const inLlmsFull = (page: LlmsPage): boolean => !page.id.startsWith("reference/schemas/");

export const renderLlmsFull = (pages: readonly LlmsPage[]): string =>
  `${pages
    .filter(inLlmsFull)
    .map((page) => `# ${page.title}\n\nSource: ${page.url}\n\n${page.body}`.trim())
    .join("\n\n---\n\n")}\n`;

/** Every list entry link target in an llms.txt, in order. */
export const llmsIndexUrls = (index: string): string[] =>
  [...index.matchAll(/^- \[[^\n]*?\]\(([^)\s]+)\)/gm)].map((match) => match[1] ?? "");

/** Map an llms.txt URL to the built file it must resolve to, or throw. */
export const builtFileFor = (url: string, base: string, site: string, outDir: string): string => {
  const parsed = new URL(url);
  if (parsed.origin !== new URL(site).origin || !parsed.pathname.startsWith(base)) {
    throw new LlmsSerializeError(`llms.txt URL is outside ${base}: ${url}`);
  }
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname.slice(base.length));
  } catch {
    throw new LlmsSerializeError("Invalid encoded llms.txt URL path");
  }
  if (path.includes("\\") || path.includes("\0") || isAbsolute(path) || path.split("/").includes(".."))
    throw new LlmsSerializeError("llms.txt URL escapes output directory");
  return containedPath(
    outDir,
    resolve(outDir, path === "" || path.endsWith("/") ? `${path}index.html` : path),
  );
};

export const writeLlmsFiles = async (
  inventory: SourceLinkInventory,
  site: string,
  outDir: string,
): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  const outputs: string[] = [];
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const path = resolve(outDir, name);
    const entry = await lstat(path).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (entry?.isSymbolicLink()) throw new LlmsSerializeError(`Refusing output symlink: ${name}`);
    outputs.push(containedPath(outDir, path));
  }
  const pages = await collectLlmsPages(inventory, site);
  const index = renderLlmsIndex(pages, inventory, site);
  const full = renderLlmsFull(pages);
  for (const [offset, path] of outputs.entries()) {
    const temporary = resolve(outDir, `.llms-${crypto.randomUUID()}`);
    try {
      await writeFile(temporary, offset === 0 ? index : full, { flag: "wx" });
      // Renaming replaces the directory entry instead of following a symlink swapped in after preflight.
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
        throw error;
      });
    }
  }
  const own = new URL(inventory.base, site).href;
  const fullUrls = [...full.matchAll(/\]\(([^)\s]+)\)/g)].map((match) =>
    (match[1] ?? "").replace(/#.*$/, ""),
  );
  const missing: string[] = [];
  for (const url of new Set([...llmsIndexUrls(index), ...fullUrls.filter((url) => url.startsWith(own))])) {
    const file = builtFileFor(url, inventory.base, site, outDir);
    if (!(await stat(file).catch(() => undefined))?.isFile())
      missing.push(`${url} (${basename(dirname(file))})`);
  }
  if (missing.length > 0) throw new LlmsSerializeError(`llms links do not resolve:\n${missing.join("\n")}`);
};
