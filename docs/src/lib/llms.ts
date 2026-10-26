import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { GuideId } from "@lando/sdk/docs/components";
import { Schema } from "effect";
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
    if (typeof value === "object" && value !== null) {
      try {
        staticValue(expressionOf(value.data?.estree));
      } catch {
        throw new LlmsSerializeError(
          `Unsupported static prop ${attribute.name} on <${node.name}> in ${at(node, file)}`,
        );
      }
    }
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

const expressionOf = (estree: unknown): EsNode | undefined => {
  const body = (estree as { body?: EsNode[] } | undefined)?.body;
  return body?.length === 1 && body[0]?.type === "ExpressionStatement"
    ? (body[0].expression as EsNode)
    : undefined;
};

type StaticValue = string | number | boolean | null | StaticValue[] | { [key: string]: StaticValue };

const staticValue = (node: EsNode | undefined): StaticValue => {
  const literal = literalOf(node);
  if (literal !== undefined) return literal;
  if (node?.type === "Literal" && node.value === null) return null;
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "-" &&
    typeof literalOf(node.argument as EsNode) === "number"
  )
    return -Number(literalOf(node.argument as EsNode));
  if (node?.type === "ArrayExpression") return (node.elements as EsNode[]).map(staticValue);
  if (node?.type === "ObjectExpression") {
    const pairs = (node.properties as EsNode[]).map((property) => {
      const key = keyOf(property);
      if (
        key === undefined ||
        property.kind !== "init" ||
        property.method === true ||
        property.shorthand === true
      )
        throw new LlmsSerializeError("Unsupported static object property");
      return [key, staticValue(property.value as EsNode)] as const;
    });
    if (new Set(pairs.map(([key]) => key)).size !== pairs.length)
      throw new LlmsSerializeError("Duplicate static object property");
    return Object.fromEntries(pairs);
  }
  throw new LlmsSerializeError("Unsupported static expression");
};

const text = (value: PropValue | undefined): string | undefined => {
  if (value === undefined || value === true || value === false) return undefined;
  if (typeof value === "string") return value;
  const decoded = staticValue(expressionOf(value.estree));
  if (typeof decoded !== "string" && typeof decoded !== "number")
    throw new LlmsSerializeError("Expected a static string or number");
  return String(decoded);
};

const isFalse = (value: PropValue | undefined): boolean =>
  value === false || (typeof value === "object" && staticValue(expressionOf(value.estree)) === false);

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

type EsNode = { readonly type: string; readonly [key: string]: unknown };

const literalOf = (node: EsNode | undefined): string | number | boolean | undefined => {
  if (node?.type === "Literal") {
    const value = node.value;
    return typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
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

type Variables = ReadonlyMap<string, string>;

const interpolate = (value: string, variables: Variables, file: string): string =>
  value.replace(/\{\{\s*([A-Za-z_$][\w$-]*)\s*\}\}/g, (_match, name: string) => {
    const replacement = variables.get(name);
    if (replacement === undefined)
      throw new LlmsSerializeError(`Unresolved public variable ${name} in ${file}`);
    return replacement;
  });

const exitNodes = (props: Map<string, PropValue>): Paragraph[] => {
  const exit = text(props.get("expectExit"));
  if (exit === undefined) return [];
  if (!/^-?\d+$/.test(exit)) throw new LlmsSerializeError("Expected a static integer expectExit");
  return [paragraph(code(`expectExit=${exit}`))];
};

const verifyNodes = (props: Map<string, PropValue>, variables: Variables, file: string): RootContent[] => {
  const target = ["command", "event", "file", "errorTag"]
    .map((key) => [key === "errorTag" ? "error" : key, text(props.get(key))] as const)
    .find((entry) => entry[1] !== undefined);
  const expect = props.get("expect");
  if (target === undefined && expect === undefined) return exitNodes(props);
  const children: Paragraph["children"] = [{ type: "text", value: "expect: " }];
  if (target !== undefined)
    children.push(
      { type: "text", value: `${target[0]} ` },
      code(interpolate(target[1] ?? "", variables, file)),
    );
  if (expect === undefined) return [paragraph(...children), ...exitNodes(props)];
  const expectation = typeof expect === "object" ? staticValue(expressionOf(expect.estree)) : expect;
  const substitute = (value: StaticValue): StaticValue => {
    if (typeof value === "string") return interpolate(value, variables, file);
    if (Array.isArray(value)) return value.map(substitute);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child)]));
    return value;
  };
  children.push(
    { type: "text", value: target === undefined ? "" : " " },
    code(`expect=${JSON.stringify(substitute(expectation))}`),
  );
  return [paragraph(...children), ...exitNodes(props)];
};

const visibleVariables = (parent: Parents, inherited: Variables, file: string): Variables => {
  const variables = new Map(inherited);
  const declared = new Map<string, string>();
  const collect = (node: Nodes): void => {
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      if (node.name !== null && (DROPPED.has(node.name) || ["Scenario", "Tab", "Tabs"].includes(node.name)))
        return;
      const props = propsOf(node, file);
      if (isFalse(props.get("render"))) return;
      if (node.name === "Variable") {
        const name = text(props.get("name"));
        const value = text(props.get("display")) ?? text(props.get("value"));
        if (name === undefined || value === undefined)
          throw new LlmsSerializeError(`Incomplete Variable in ${at(node, file)}`);
        if (declared.has(name) && declared.get(name) !== value)
          throw new LlmsSerializeError(`Conflicting public variable ${name} in ${at(node, file)}`);
        declared.set(name, value);
        variables.set(name, value);
      }
    }
    if ("children" in node) for (const child of node.children) collect(child as Nodes);
  };
  for (const child of parent.children) collect(child as Nodes);
  return variables;
};

/** Replace one guide component with plain markdown nodes. */
const replaceComponent = (
  node: JsxElement,
  options: SerializeOptions,
  source: string,
  variables: Variables,
): RootContent[] => {
  const name = node.name;
  if (name === null || name === undefined)
    return transformChildren(node, options, source, variables).children as RootContent[];
  if (!KNOWN_COMPONENTS.has(name) && !/^[a-z]/.test(name)) {
    throw new LlmsSerializeError(`Unknown MDX component <${name}> in ${at(node, options.file)}`);
  }
  const props = propsOf(node, options.file);
  if (isFalse(props.get("render")) || DROPPED.has(name)) return [];
  if (/^[a-z]/.test(name)) {
    if (["br", "hr"].includes(name)) return [{ type: "html", value: `<${name}>` } satisfies Html];
    if (!["div", "span", "section", "article", "details", "summary", "p", "kbd", "sup", "sub"].includes(name))
      throw new LlmsSerializeError(`Unsupported HTML element <${name}> in ${at(node, options.file)}`);
    return transformChildren(node, options, source, variables).children as RootContent[];
  }
  const scoped =
    name === "Scenario" || name === "Tab" ? visibleVariables(node, variables, options.file) : variables;
  if (UNWRAPPED.has(name)) return transformChildren(node, options, source, scoped).children as RootContent[];
  switch (name) {
    case "Run": {
      const command =
        text(props.get("displayCode")) ??
        text(props.get("command")) ??
        text(props.get("shell")) ??
        text(props.get("code"));
      if (command === undefined || command.trim() === "")
        throw new LlmsSerializeError(`<Run> without a command in ${at(node, options.file)}`);
      return [
        fence(
          text(props.get("runtime")) === "library" ? "ts" : "sh",
          interpolate(command, variables, at(node, options.file)),
        ),
        ...exitNodes(props),
      ];
    }
    case "Verify":
      return verifyNodes(props, variables, at(node, options.file));
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
      return [
        paragraph(label),
        ...(transformChildren(node, options, source, scoped).children as RootContent[]),
      ];
    }
    default:
      throw new LlmsSerializeError(`No llms serialization for <${name}> in ${at(node, options.file)}`);
  }
};

const isComment = (value: string): boolean => /^\s*\/\*[\s\S]*\*\/\s*$/.test(value);

function transformChildren<T extends Parents>(
  parent: T,
  options: SerializeOptions,
  source: string,
  variables: Variables,
): T {
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
        next.push(...replaceComponent(child, options, source, variables));
        break;
      default:
        if (child.type === "paragraph") {
          const transformed = transformChildren(child, options, source, variables);
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
        } else next.push("children" in child ? transformChildren(child, options, source, variables) : child);
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
  const out = dropLeadingHeading(
    transformChildren(tree, options, input, visibleVariables(tree, new Map(), options.file)),
  );
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
  const pages = await collectLlmsPages(inventory, site);
  const index = renderLlmsIndex(pages, inventory, site);
  await mkdir(outDir, { recursive: true });
  await writeFile(containedPath(outDir, resolve(outDir, "llms.txt")), index);
  const full = renderLlmsFull(pages);
  await writeFile(containedPath(outDir, resolve(outDir, "llms-full.txt")), full);
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
