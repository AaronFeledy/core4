#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Result } from "effect";
import type { Root } from "mdast";
import { decodeGuideFrontmatterEither } from "../sdk/src/docs/components/index.ts";
import type { GuidePlatform } from "../sdk/src/docs/guide-frontmatter.ts";
import { discoverGuideMdxFiles, resolveHostGuidePlatform } from "./build-guide-scenarios.ts";
import { lintComponentSyntax, lintEditorial } from "./guides/editorial-lint.ts";
import {
  type GuideFixtureInventoryEntry,
  buildFixtureInventory,
  lintFixtures,
} from "./guides/fixture-lint.ts";
import {
  type GuideLintDiagnostic,
  diagnostic,
  errorDiagnostic,
  formatErrorMessage,
} from "./guides/lint-diagnostic.ts";
import { firstYaml, parseFrontmatter, processor } from "./guides/mdx.ts";
import type { GuideScenarioAst } from "./guides/model.ts";
import { parseGuideRoot, parseGuideScenarioAst } from "./guides/parser.ts";
import { buildPublicTranscript } from "./guides/public-transcript.ts";
import { checkScenarioSourceMap, checkTranscriptFrameDiscipline } from "./guides/source-map.ts";
import { renderScenarioTest } from "./guides/test-render.ts";
import { variantsOf } from "./guides/variants.ts";
import { lintYamlFences } from "./lint-guides-yaml-fence.ts";
import { lintFixtureLandofiles } from "./lint-guides-yaml-fixtures.ts";

export type { GuideLintDiagnostic, GuideFixtureInventoryEntry };
export { checkScenarioSourceMap, checkTranscriptFrameDiscipline };
export interface GuideLintResult {
  readonly diagnostics: ReadonlyArray<GuideLintDiagnostic>;
}
export interface GuideLintContentOptions {
  readonly fixtures?: ReadonlyArray<GuideFixtureInventoryEntry>;
}
export interface GuideLintOptions {
  readonly guideRoot?: string;
}
const REPO_ROOT = resolve(import.meta.dirname, "..");

const lintParsed = (
  sourcePath: string,
  root: Root,
  options: GuideLintContentOptions,
): GuideLintResult & { readonly guide?: GuideScenarioAst } => {
  try {
    const diagnostics: GuideLintDiagnostic[] = [];
    const yamlNode = root.children?.find((node) => node.type === "yaml") ?? root;
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatter(sourcePath, firstYaml(root));
    } catch (error) {
      return {
        diagnostics: [
          diagnostic(
            sourcePath,
            yamlNode,
            "guide.frontmatter",
            `Invalid frontmatter: ${formatErrorMessage(error)}`,
          ),
        ],
      };
    }
    const { diataxis: _diataxis, ...schemaFrontmatter } = frontmatter;
    const decoded = decodeGuideFrontmatterEither(schemaFrontmatter);
    if (Result.isFailure(decoded))
      diagnostics.push(
        diagnostic(
          sourcePath,
          yamlNode,
          "guide.frontmatter",
          `Invalid frontmatter: ${formatErrorMessage(decoded.failure)}`,
        ),
      );
    diagnostics.push(
      ...lintComponentSyntax(sourcePath, root),
      ...lintEditorial(sourcePath, root, frontmatter),
    );
    lintYamlFences(sourcePath, root, diagnostics);
    diagnostics.push(...lintFixtures(sourcePath, root, { frontmatter, fixtures: options.fixtures ?? [] }));
    if (diagnostics.length === 0) return { diagnostics, guide: parseGuideRoot(sourcePath, root) };
    return { diagnostics };
  } catch (error) {
    return { diagnostics: [errorDiagnostic(sourcePath, error)] };
  }
};
export const lintGuideContent = (
  sourcePath: string,
  content: string,
  options: GuideLintContentOptions = {},
): GuideLintResult => {
  try {
    return { diagnostics: lintParsed(sourcePath, processor.parse(content), options).diagnostics };
  } catch (error) {
    return { diagnostics: [errorDiagnostic(sourcePath, error)] };
  }
};
const lintResolvedTranscripts = (guide: GuideScenarioAst, hostPlatform: GuidePlatform): GuideLintResult => {
  const diagnostics: GuideLintDiagnostic[] = [];
  for (const scenario of guide.scenarios)
    for (const variant of variantsOf(guide)) {
      const transcript = buildPublicTranscript(guide, scenario, variant);
      if (transcript !== undefined)
        diagnostics.push(...checkTranscriptFrameDiscipline(scenario, transcript.frames, guide.sourcePath));
      diagnostics.push(
        ...checkScenarioSourceMap(
          renderScenarioTest(guide, scenario, variant, hostPlatform),
          guide.sourcePath,
          scenario.line,
        ),
      );
    }
  return { diagnostics };
};
export const lintGuideTranscripts = (
  sourcePath: string,
  content: string,
  hostPlatform: GuidePlatform = resolveHostGuidePlatform(),
): GuideLintResult => {
  try {
    return lintResolvedTranscripts(parseGuideScenarioAst(sourcePath, content), hostPlatform);
  } catch (error) {
    return { diagnostics: [errorDiagnostic(sourcePath, error)] };
  }
};
const discoverLintFiles = async (
  root: string,
  guideRoot: string | undefined,
): Promise<ReadonlyArray<string>> => {
  if (guideRoot === undefined) return discoverGuideMdxFiles(root);
  const walk = async (dir: string): Promise<ReadonlyArray<string>> => {
    const entries = await readdir(dir, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const child = resolve(dir, entry.name);
          return entry.isDirectory()
            ? walk(child)
            : entry.isFile() && entry.name.endsWith(".mdx")
              ? [relative(root, child).split("\\").join("/")]
              : [];
        }),
      )
    ).flat();
  };
  return [...(await walk(resolve(root, guideRoot)))].sort((a, b) => a.localeCompare(b));
};
export const lintGuides = async (
  root = REPO_ROOT,
  options: GuideLintOptions = {},
): Promise<GuideLintResult> => {
  const diagnostics: GuideLintDiagnostic[] = [];
  for (const sourcePath of await discoverLintFiles(root, options.guideRoot)) {
    const content = await Bun.file(resolve(root, sourcePath)).text();
    let mdx: Root;
    let frontmatter: Record<string, unknown> = {};
    try {
      mdx = processor.parse(content);
      frontmatter = parseFrontmatter(sourcePath, firstYaml(mdx));
    } catch (error) {
      diagnostics.push(errorDiagnostic(sourcePath, error));
      continue;
    }
    const fixtures =
      typeof frontmatter.id === "string"
        ? await buildFixtureInventory(root, frontmatter.id, options.guideRoot)
        : [];
    const result = lintParsed(sourcePath, mdx, { fixtures });
    diagnostics.push(...result.diagnostics);
    await lintFixtureLandofiles(root, fixtures, diagnostics);
    if (result.guide !== undefined)
      diagnostics.push(...lintResolvedTranscripts(result.guide, resolveHostGuidePlatform()).diagnostics);
  }
  return { diagnostics };
};
export const formatGuideLintDiagnostic = (entry: GuideLintDiagnostic): string =>
  `${entry.sourcePath}:${entry.line}:${entry.column}: ${entry.code}: ${entry.message}`;
if (import.meta.main) {
  const guideRoot = process.env.GUIDES_DIR_OVERRIDE;
  const result = await lintGuides(REPO_ROOT, {
    ...(guideRoot === undefined || guideRoot.trim() === "" ? {} : { guideRoot }),
  });
  if (result.diagnostics.length === 0) process.stdout.write("Guide lint passed.\n");
  else {
    process.stderr.write(`${result.diagnostics.map(formatGuideLintDiagnostic).join("\n")}\n`);
    process.exitCode = 1;
  }
}
