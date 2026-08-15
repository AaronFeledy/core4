import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  type MdxJsxAttribute,
  type MdxJsxFlowElement,
  type MdxJsxTextElement,
  mdxFromMarkdown,
} from "mdast-util-mdx";
import { mdxjs } from "micromark-extension-mdxjs";
import type { Node, Parent } from "unist";
import { VFile } from "vfile";

import { variantFileSuffix } from "@lando/core/docs/variant";

import { buildGuideScenarioAst, emitPublicTranscripts } from "../../scripts/build-guide-scenarios.ts";
import { transcriptPathFor } from "../src/lib/transcripts.ts";
import { remarkGuideContext } from "../src/plugins/remark-guide-context.ts";

type MdxElement = MdxJsxFlowElement | MdxJsxTextElement;

const repoRoot = resolve(import.meta.dir, "../..");

const isParent = (node: Node): node is Parent => "children" in node && Array.isArray(node.children);

const isMdxElement = (node: Node): node is MdxElement =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

const descendants = (tree: Root): readonly Node[] => {
  const nodes: Node[] = [];
  const collect = (node: Node): void => {
    nodes.push(node);
    if (!isParent(node)) return;
    for (const child of node.children) collect(child);
  };
  collect(tree);
  return nodes;
};

const stringAttribute = (element: MdxElement, name: string): string | undefined => {
  const attribute = element.attributes.find(
    (entry): entry is MdxJsxAttribute => entry.type === "mdxJsxAttribute" && entry.name === name,
  );
  return typeof attribute?.value === "string" ? attribute.value : undefined;
};

const parseFrontmatterAxes = (
  source: string,
): {
  readonly id: string;
  readonly tabs?: readonly string[];
  readonly axes?: Record<string, readonly string[]>;
} => {
  const match = /^---\n([\s\S]*?)\n---/m.exec(source);
  if (match === null) throw new RangeError("Expected YAML frontmatter.");
  const body = match[1] ?? "";
  const idMatch = /^id:\s*(\S+)\s*$/m.exec(body);
  if (idMatch?.[1] === undefined) throw new RangeError("Expected frontmatter id.");
  const id = idMatch[1];
  const tabsMatch = /^tabs:\s*\[([^\]]*)\]\s*$/m.exec(body);
  if (tabsMatch?.[1] !== undefined) {
    const tabs = tabsMatch[1]
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return { id, tabs };
  }
  const axesBlock = /^axes:\n((?: {2}.+\n?)+)/m.exec(`${body}\n`);
  if (axesBlock?.[1] === undefined) return { id };
  const axes: Record<string, readonly string[]> = {};
  for (const line of axesBlock[1].split("\n")) {
    const axisMatch = /^\s{2}([a-z][a-z0-9-]*):\s*\[([^\]]*)\]\s*$/.exec(line);
    if (axisMatch?.[1] === undefined || axisMatch[2] === undefined) continue;
    axes[axisMatch[1]] = axisMatch[2]
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return { id, axes };
};

const renderGuideContext = (source: string, guidePath: string): Root => {
  const tree = fromMarkdown(source, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  });
  const fm = parseFrontmatterAxes(source);
  const file = new VFile({
    value: source,
    path: guidePath,
    data: {
      astro: {
        frontmatter: {
          id: fm.id,
          ...(fm.tabs === undefined ? {} : { tabs: fm.tabs }),
          ...(fm.axes === undefined ? {} : { axes: fm.axes }),
        },
      },
    },
  });
  remarkGuideContext()(tree, file);
  return tree;
};

const renderedVariantFilenames = (tree: Root, scenarioId: string): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const node of descendants(tree)) {
    if (!isMdxElement(node)) continue;
    const variant = stringAttribute(node, "data-variant");
    if (variant === undefined) continue;
    names.add(`${scenarioId}${variantFileSuffix(variant)}.json`);
  }
  return names;
};

const emittedBasenames = (written: readonly string[], guideId: string): ReadonlySet<string> => {
  const prefix = `/guides/${guideId}/`;
  const names = new Set<string>();
  for (const relative of written) {
    const normalized = relative.replaceAll("\\", "/");
    const index = normalized.lastIndexOf(prefix);
    if (index < 0) continue;
    names.add(basename(normalized));
  }
  return names;
};

const assertEveryRenderedVariantResolves = async (
  tree: Root,
  guideId: string,
  transcriptRoot: string,
): Promise<void> => {
  for (const node of descendants(tree)) {
    if (!isMdxElement(node)) continue;
    const scenarioId = stringAttribute(node, "data-scenario-id");
    const variant = stringAttribute(node, "data-variant");
    if (scenarioId === undefined || variant === undefined) continue;
    const path = transcriptPathFor({ guideId, scenarioId, variant }, transcriptRoot);
    expect(path, `expected safe transcript path for ${scenarioId} variant ${variant}`).toBeDefined();
    if (path === undefined) throw new Error("expected safe transcript path");
    const exists = await Bun.file(path).exists();
    expect(exists, `expected transcript for ${scenarioId} variant ${variant} at ${path}`).toBe(true);
  }
};

const withTempGuideRoot = async (
  relativeGuidePath: string,
  source: string,
  run: (root: string, guideAbsolutePath: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-variant-pair-"));
  try {
    const guideAbsolutePath = join(root, relativeGuidePath);
    await mkdir(resolve(guideAbsolutePath, ".."), { recursive: true });
    await Bun.write(guideAbsolutePath, source);
    await symlink(resolve(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
    await run(root, guideAbsolutePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("variant pairing between public transcripts and remark context", () => {
  test("pairs tabs fixture emitted paths with rendered data-variant filenames", async () => {
    // Given: a single-axis tabs guide with axisless Tabs.
    const source = `---
id: pair-tabs
provider: test
tabs: [postgres, mysql]
---

<Guide>
  <Scenario id="choose">
    <Tabs>
      <Tab name="postgres">
        <Step name="run-pg">
          <Run command="lando version" />
        </Step>
      </Tab>
      <Tab name="mysql">
        <Step name="run-my">
          <Run command="lando version" />
        </Step>
      </Tab>
    </Tabs>
  </Scenario>
</Guide>
`;

    await withTempGuideRoot("docs/guides/pair-tabs.mdx", source, async (root, guidePath) => {
      // When: public transcripts are emitted and the same MDX is transformed for render.
      const transcriptRoot = "dist/transcripts/public/guides";
      const written = await emitPublicTranscripts(await buildGuideScenarioAst(root), root, transcriptRoot);
      const tree = renderGuideContext(source, guidePath);

      // Then: emitted basenames equal rendered variantFileSuffix names, and each resolves on disk.
      const emitted = emittedBasenames(written, "pair-tabs");
      const rendered = renderedVariantFilenames(tree, "choose");
      expect([...emitted].sort()).toEqual([...rendered].sort());
      expect([...emitted].sort()).toEqual(["choose.default=mysql.json", "choose.default=postgres.json"]);
      await assertEveryRenderedVariantResolves(tree, "pair-tabs", join(root, transcriptRoot));
    });
  });

  test("pairs multi-axis nested fixture emitted paths with rendered data-variant filenames", async () => {
    // Given: nested Tabs covering the full Cartesian product in declaration order.
    const source = `---
id: pair-axes
provider: test
axes:
  os: [linux, macos]
  package-manager: [composer, npm]
---

<Guide>
  <Scenario id="matrix">
    <Tabs axis="os">
      <Tab name="linux">
        <Tabs axis="package-manager">
          <Tab name="composer">
            <Step name="lc">
              <Run command="lando version" />
            </Step>
          </Tab>
          <Tab name="npm">
            <Step name="ln">
              <Run command="lando version" />
            </Step>
          </Tab>
        </Tabs>
      </Tab>
      <Tab name="macos">
        <Tabs axis="package-manager">
          <Tab name="composer">
            <Step name="mc">
              <Run command="lando version" />
            </Step>
          </Tab>
          <Tab name="npm">
            <Step name="mn">
              <Run command="lando version" />
            </Step>
          </Tab>
        </Tabs>
      </Tab>
    </Tabs>
  </Scenario>
</Guide>
`;

    await withTempGuideRoot("docs/guides/pair-axes.mdx", source, async (root, guidePath) => {
      // When: public transcripts are emitted and the same MDX is transformed for render.
      const transcriptRoot = "dist/transcripts/public/guides";
      const written = await emitPublicTranscripts(await buildGuideScenarioAst(root), root, transcriptRoot);
      const tree = renderGuideContext(source, guidePath);

      // Then: full Cartesian filename sets match and every rendered variant resolves.
      const emitted = emittedBasenames(written, "pair-axes");
      const rendered = renderedVariantFilenames(tree, "matrix");
      expect([...emitted].sort()).toEqual([...rendered].sort());
      expect([...emitted].sort()).toEqual([
        "matrix.os=linux.package-manager=composer.json",
        "matrix.os=linux.package-manager=npm.json",
        "matrix.os=macos.package-manager=composer.json",
        "matrix.os=macos.package-manager=npm.json",
      ]);
      await assertEveryRenderedVariantResolves(tree, "pair-axes", join(root, transcriptRoot));
    });
  });
});
