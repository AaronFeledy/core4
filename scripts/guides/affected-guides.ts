import { resolve } from "node:path";
import {
  decodeFrontmatter,
  firstYaml,
  parseFrontmatter,
  processor,
} from "../../core/src/docs/guide-compiler/mdx.ts";
import type { GuidePlatform } from "../../sdk/src/docs/guide-frontmatter.ts";
import { resolveHostGuidePlatform } from "../build-guide-scenarios.ts";
import { discoverGuideMdxFiles, pathTouchesGuide } from "./discovery.ts";
import { scenarioDisposition } from "./disposition.ts";
import {
  type HomeGuideEntry,
  type RegistryDiagnostic,
  loadHomeGuideRegistry,
} from "./home-guide-registry.ts";
import type { GuideVariant } from "./model.ts";
import { parseGuideScenarioAst } from "./parser.ts";
import { variantsOf } from "./variants.ts";

export interface AffectedScenarioVariant {
  readonly scenarioId: string;
  /** `axis=value` pairs, empty for a guide without axes. */
  readonly label: string;
  readonly layer: string;
  readonly skip?: { readonly kind: string; readonly reason: string };
}

export interface AffectedGuide {
  readonly guide: string;
  readonly guideId: string;
  /** Why this guide was selected, one line per changed path. */
  readonly reasons: readonly string[];
  readonly variants: readonly AffectedScenarioVariant[];
}

export interface AffectedGuidesSelection {
  /** Repository root the selection was read from. */
  readonly root: string;
  readonly guides: readonly AffectedGuide[];
  readonly diagnostics: readonly RegistryDiagnostic[];
  /** Changed paths that selected a guide, so they are not reported as unmatched. */
  readonly selectedPaths: readonly string[];
}

interface SelectAffectedGuidesInput {
  readonly root: string;
  readonly changed: readonly string[];
  readonly hostPlatform?: GuidePlatform;
  /** Test seam: an injected map instead of the checked-in HOME_GUIDES. */
  readonly entries?: readonly HomeGuideEntry[];
}

const normalize = (path: string): string => path.replaceAll("\\", "/");

const variantLabel = (variant: GuideVariant | undefined): string =>
  variant === undefined || variant.pairs.length === 0
    ? ""
    : [...variant.pairs]
        .sort((left, right) => left.axis.localeCompare(right.axis))
        .map((pair) => `${pair.axis}=${pair.value}`)
        .join(" ");

const fixtureGuideId = (path: string): string | undefined =>
  /^docs\/guides\/([^/]+)\/fixtures\//.exec(path)?.[1];

const guideIdIndex = async (
  root: string,
  discovered: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const byId = new Map<string, string>();
  for (const guidePath of discovered) {
    try {
      const content = await Bun.file(resolve(root, guidePath)).text();
      const frontmatter = decodeFrontmatter(
        guidePath,
        parseFrontmatter(guidePath, firstYaml(processor.parse(content))),
      );
      if (!byId.has(frontmatter.id)) byId.set(frontmatter.id, guidePath);
    } catch {
      // An unrelated guide with broken frontmatter must not break fixture
      // selection; lint and the map gates report it on its own.
    }
  }
  return byId;
};

/**
 * Selects the guides a change set affects: a covered source selects every
 * feature that owns it, a guide page selects itself, and a fixture under
 * `docs/guides/<id>/fixtures/` selects the guide with that frontmatter id.
 * Reasons accumulate, so one path can be both a covered source and a guide or
 * fixture change. Case files (`.cases.ts`) select nothing.
 */
export const selectAffectedGuides = async (
  input: SelectAffectedGuidesInput,
): Promise<AffectedGuidesSelection> => {
  const registry = await loadHomeGuideRegistry(
    input.root,
    input.entries === undefined ? {} : { entries: input.entries },
  );
  // A map that cannot be trusted must fail selection before any guide is
  // selected or parsed, so the caller prints every diagnostic instead of a stack.
  if (registry.diagnostics.length > 0) {
    return {
      root: input.root,
      guides: [],
      diagnostics: registry.diagnostics,
      selectedPaths: [],
    };
  }
  const changed = [...new Set(input.changed.map(normalize))].sort();
  const discovered = await discoverGuideMdxFiles(input.root);
  const discoveredSet = new Set(discovered.map(normalize));
  const reasons = new Map<string, string[]>();
  const selectedPaths = new Set<string>();
  let ids: ReadonlyMap<string, string> | undefined;

  const select = (guidePath: string, reason: string): void => {
    const list = reasons.get(guidePath) ?? [];
    list.push(reason);
    reasons.set(guidePath, list);
  };

  for (const path of changed) {
    if (path.endsWith(".cases.ts")) continue;
    let matched = false;
    for (const owner of registry.ownersOf(path)) {
      select(owner.guide, `${path} -> feature ${owner.feature}`);
      matched = true;
    }
    if (discoveredSet.has(path)) {
      select(path, `${path} guide changed`);
      matched = true;
    }
    const id = fixtureGuideId(path);
    if (id !== undefined) {
      ids ??= await guideIdIndex(input.root, discovered);
      const guidePath = ids.get(id);
      if (guidePath !== undefined && pathTouchesGuide(path, { guidePath, guideId: id })) {
        select(guidePath, `${path} fixture of guide ${id}`);
        matched = true;
      }
    }
    if (matched) selectedPaths.add(path);
  }

  const hostPlatform = input.hostPlatform ?? resolveHostGuidePlatform();
  const guides: Array<AffectedGuide> = [];
  const parseDiagnostics: Array<RegistryDiagnostic> = [];
  for (const guidePath of [...reasons.keys()].sort()) {
    let ast: ReturnType<typeof parseGuideScenarioAst>;
    try {
      ast = parseGuideScenarioAst(guidePath, await Bun.file(resolve(input.root, guidePath)).text());
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      parseDiagnostics.push({
        code: "selection.guide-invalid",
        message: `Selected guide "${guidePath}" could not be read or parsed: ${detail}. Fix the guide before selecting it.`,
      });
      continue;
    }
    const variants = ast.scenarios.flatMap((scenario) =>
      variantsOf(ast).map((variant) => {
        const disposition = scenarioDisposition(ast, scenario, variant, hostPlatform);
        return {
          scenarioId: scenario.id,
          label: variantLabel(variant),
          layer: disposition.layer,
          ...(disposition.skip === undefined ? {} : { skip: disposition.skip }),
        };
      }),
    );
    guides.push({
      guide: guidePath,
      guideId: ast.frontmatter.id,
      reasons: reasons.get(guidePath) ?? [],
      variants,
    });
  }
  return {
    root: input.root,
    guides,
    diagnostics: parseDiagnostics,
    selectedPaths: [...selectedPaths].sort(),
  };
};
