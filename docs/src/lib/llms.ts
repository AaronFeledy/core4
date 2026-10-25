import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import type { Code, Html, InlineCode, Nodes, Paragraph, Parents, Root, RootContent, Strong } from "mdast";
import type {
  MdxJsxAttribute,
  MdxJsxExpressionAttribute,
  MdxJsxFlowElement,
  MdxJsxTextElement,
} from "mdast-util-mdx";
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
type PropValue = string | boolean | { readonly expression: string; readonly estree?: unknown };

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
  const props = new Map<string, PropValue>();
  for (const attribute of node.attributes as (MdxJsxAttribute | MdxJsxExpressionAttribute)[]) {
    if (attribute.type !== "mdxJsxAttribute") {
      throw new LlmsSerializeError(`Unsupported spread props on <${node.name}> in ${file}`);
    }
    const { value } = attribute;
    props.set(
      attribute.name,
      value === null || value === undefined
        ? true
        : typeof value === "string"
          ? value
          : { expression: value.value, estree: value.data?.estree },
    );
  }
  return props;
};

const text = (value: PropValue | undefined): string | undefined => {
  if (value === undefined || value === true || value === false) return undefined;
  if (typeof value === "string") return value;
  const trimmed = value.expression.trim();
  const literal = /^(["'`])([\s\S]*)\1$/.exec(trimmed);
  if (literal !== null) return literal[2];
  return trimmed;
};

const isFalse = (value: PropValue | undefined): boolean =>
  value === false || (typeof value === "object" && value.expression.trim() === "false");

const at = (node: Nodes, file: string): string =>
  node.position === undefined ? file : `${file}:${node.position.start.line}`;

const fence = (lang: string, value: string): Code => ({
  type: "code",
  lang,
  value: value.replace(/\n$/, ""),
});
const paragraph = (...children: Paragraph["children"]): Paragraph => ({ type: "paragraph", children });
const code = (value: string): InlineCode => ({ type: "inlineCode", value });

const fixtureNodes = (name: string, options: SerializeOptions, node: Nodes): RootContent[] => {
  for (const root of options.fixtureRoots ?? []) {
    const directory = resolve(root, name);
    if (!existsSync(directory)) continue;
    for (const candidate of [".lando.yml", "recipe.yml"]) {
      const path = resolve(directory, candidate);
      if (!existsSync(path)) continue;
      return [
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
        fence("yaml", readFileSync(path, "utf8")),
      ];
    }
    throw new LlmsSerializeError(
      `Fixture "${name}" has no .lando.yml or recipe.yml (${relative(process.cwd(), directory)}) in ${at(node, options.file)}`,
    );
  }
  throw new LlmsSerializeError(`Fixture "${name}" not found for <UseFixture> in ${at(node, options.file)}`);
};

type EsNode = { readonly type: string; readonly [key: string]: unknown };

const MATCHERS: Readonly<Record<string, string>> = {
  regex: "matches",
  contains: "contains",
  equals: "equals",
};
const display = (value: string): string => value.replace(/\n/g, "\\n");

const literalOf = (node: EsNode | undefined): string | number | boolean | undefined => {
  if (node?.type === "Literal") {
    const value = node.value;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : undefined;
  }
  if (node?.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const cooked = (node.quasis as { value: { cooked?: string } }[])[0]?.value.cooked;
    return cooked ?? undefined;
  }
  return undefined;
};

const keyOf = (property: EsNode): string | undefined => {
  if (property.type !== "Property" || property.computed === true) return undefined;
  const key = property.key as EsNode;
  return key.type === "Identifier" ? String(key.name) : typeof key.value === "string" ? key.value : undefined;
};

// Describe one matcher value, such as "x", { regex: "x" }, { not: ... } or { anyOf: [...] }.
const describeMatcher = (node: EsNode | undefined): string[] | undefined => {
  const literal = literalOf(node);
  if (literal !== undefined) return [typeof literal === "string" ? "equals" : "is", display(String(literal))];
  if (node?.type !== "ObjectExpression") return undefined;
  const properties = node.properties as EsNode[];
  if (properties.length !== 1) return undefined;
  const [property] = properties;
  const key = property === undefined ? undefined : keyOf(property);
  const value = property?.value as EsNode | undefined;
  if (key === undefined) return undefined;
  const verb = MATCHERS[key];
  if (verb !== undefined) {
    const pattern = literalOf(value);
    return typeof pattern === "string" ? [verb, display(pattern)] : undefined;
  }
  if (key === "not") {
    const inner = describeMatcher(value);
    return inner === undefined ? undefined : [`not ${inner[0]}`, ...inner.slice(1)];
  }
  if (key === "anyOf" && value?.type === "ArrayExpression") {
    const options = (value.elements as EsNode[]).map(literalOf);
    if (options.some((option) => typeof option !== "string")) return undefined;
    return ["is one of", ...options.map((option) => display(String(option)))];
  }
  return undefined;
};

type Clause = { readonly subject: string; readonly verb: string; readonly values: readonly string[] };

/** Parse a Verify `expect` object into readable clauses, or undefined for shapes we do not know. */
export const describeExpectation = (estree: unknown): Clause[] | undefined => {
  const statement = (estree as { body?: EsNode[] } | undefined)?.body?.[0];
  const expression = statement?.type === "ExpressionStatement" ? (statement.expression as EsNode) : undefined;
  const top = describeMatcher(expression);
  if (top !== undefined) return [{ subject: "output", verb: top[0] ?? "", values: top.slice(1) }];
  if (expression?.type !== "ObjectExpression") return undefined;
  const clauses: Clause[] = [];
  for (const property of expression.properties as EsNode[]) {
    const key = keyOf(property);
    if (key === undefined) return undefined;
    const value = property.value as EsNode;
    const described =
      key in MATCHERS || key === "not" || key === "anyOf" ? undefined : describeMatcher(value);
    if (described === undefined) {
      const whole = describeMatcher({ type: "ObjectExpression", properties: [property] });
      if (whole === undefined) return undefined;
      clauses.push({ subject: "output", verb: whole[0] ?? "", values: whole.slice(1) });
    } else clauses.push({ subject: key, verb: described[0] ?? "", values: described.slice(1) });
  }
  return clauses.length === 0 ? undefined : clauses;
};

const verifyNodes = (props: Map<string, PropValue>): RootContent[] => {
  const target = ["command", "event", "file", "errorTag"]
    .map((key) => [key === "errorTag" ? "error" : key, text(props.get(key))] as const)
    .find((entry) => entry[1] !== undefined);
  const expect = props.get("expect");
  const expectation = text(expect);
  if (target === undefined && expectation === undefined) return [];
  const children: Paragraph["children"] = [{ type: "text", value: "expect: " }];
  if (target !== undefined) children.push({ type: "text", value: `${target[0]} ` }, code(target[1] ?? ""));
  if (expectation === undefined) return [paragraph(...children)];
  const clauses =
    typeof expect === "object"
      ? describeExpectation(expect.estree)
      : [{ subject: "output", verb: "equals", values: [display(expectation)] }];
  if (clauses === undefined) {
    if (target !== undefined) children.push({ type: "text", value: " matches " });
    children.push(code(expectation.replace(/\s+/g, " ")));
    return [paragraph(...children)];
  }
  clauses.forEach((clause, index) => {
    children.push({
      type: "text",
      value: `${index === 0 ? (target === undefined ? "" : " ") : ", "}${clause.subject} ${clause.verb} `,
    });
    clause.values.forEach((value, at) => {
      if (at > 0) children.push({ type: "text", value: " or " });
      children.push(code(value));
    });
  });
  return [paragraph(...children)];
};

/** Replace one guide component with plain markdown nodes. */
const replaceComponent = (node: JsxElement, options: SerializeOptions, source: string): RootContent[] => {
  const name = node.name;
  if (name === null || name === undefined)
    return transformChildren(node, options, source).children as RootContent[];
  // Lowercase names are plain HTML written as JSX, such as <br />. Keep their source.
  if (/^[a-z]/.test(name)) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const raw = start === undefined || end === undefined ? "" : source.slice(start, end);
    return [{ type: "html", value: raw } satisfies Html];
  }
  if (!KNOWN_COMPONENTS.has(name)) {
    throw new LlmsSerializeError(`Unknown MDX component <${name}> in ${at(node, options.file)}`);
  }
  const props = propsOf(node, options.file);
  if (isFalse(props.get("render")) || DROPPED.has(name)) return [];
  if (UNWRAPPED.has(name)) return transformChildren(node, options, source).children as RootContent[];
  switch (name) {
    case "Run": {
      const command =
        text(props.get("displayCode")) ??
        text(props.get("command")) ??
        text(props.get("shell")) ??
        text(props.get("code"));
      if (command === undefined || command.trim() === "")
        throw new LlmsSerializeError(`<Run> without a command in ${at(node, options.file)}`);
      return [fence(text(props.get("runtime")) === "library" ? "ts" : "sh", command)];
    }
    case "Verify":
      return verifyNodes(props);
    case "Inline":
      return [fence(text(props.get("lang")) ?? "ts", text(props.get("code")) ?? "")];
    case "Variable":
      return [code(text(props.get("display")) ?? text(props.get("value")) ?? "") as RootContent];
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
        next.push("children" in child ? transformChildren(child, options, source) : child);
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
  const input = /\/docs\/reference\/.*\.mdx$/.test(options.file)
    ? escapeReferenceMdxPlaceholders(source)
    : source;
  const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
  if (isMdx) processor.use(remarkMdx);
  const tree = processor.parse(input) as Root;
  const out = dropLeadingHeading(transformChildren(tree, options, input));
  if (options.links !== undefined) absolutizeLinks(out, options.file, options.links);
  return stringify(out);
};

export const fixtureRootsFor = (docsRoot: string, frontmatter: Record<string, unknown>): string[] => {
  const id = typeof frontmatter.id === "string" ? frontmatter.id : undefined;
  return [
    ...(id === undefined ? [] : [resolve(docsRoot, "guides", id, "fixtures")]),
    resolve(docsRoot, "guides", "fixtures"),
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
    `- [Full documentation as plain Markdown](${url("llms-full.txt")}): every page below in one file.`,
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
  const path = decodeURIComponent(parsed.pathname.slice(base.length));
  return resolve(outDir, path === "" || path.endsWith("/") ? `${path}index.html` : path);
};

export const writeLlmsFiles = async (
  inventory: SourceLinkInventory,
  site: string,
  outDir: string,
): Promise<void> => {
  const pages = await collectLlmsPages(inventory, site);
  const index = renderLlmsIndex(pages, inventory, site);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "llms.txt"), index);
  const full = renderLlmsFull(pages);
  await writeFile(resolve(outDir, "llms-full.txt"), full);
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
