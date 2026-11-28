import { isAbsolute, resolve } from "node:path";

import { listGitVisibleFiles } from "../git-changes.ts";
import { discoverGuideMdxFiles } from "./discovery.ts";
import { HOME_GUIDES } from "./home-guides.ts";
import { parseGuideScenarioAst } from "./parser.ts";

export interface HomeGuideEntry {
  /** Kebab-case feature id. One feature never has two home guides. */
  readonly feature: string;
  /** Repo-relative guide path under a discovery root. */
  readonly guide: string;
  /** Non-empty list of repo-relative source paths or globs this feature covers. */
  readonly sources: readonly string[];
}

export type MappedGuide =
  | { readonly kind: "parsed"; readonly guideId: string; readonly scenarioCount: number }
  | { readonly kind: "invalid"; readonly error: string };

export interface RegistryDiagnostic {
  readonly code: string;
  readonly message: string;
}

interface ValidateHomeGuidesInput {
  readonly entries: readonly HomeGuideEntry[];
  /**
   * Every guide `discoverGuideMdxFiles` returned, mapped to its parse outcome
   * (`undefined` for a discovered guide the map does not name).
   */
  readonly guides: ReadonlyMap<string, MappedGuide | undefined>;
  /** Git-visible repo-relative files: tracked plus non-ignored untracked. */
  readonly files: readonly string[];
}

export interface HomeGuideRegistry {
  readonly entries: readonly HomeGuideEntry[];
  readonly diagnostics: readonly RegistryDiagnostic[];
  /**
   * Every feature owning a path: an exact path wins, otherwise every matching
   * glob. A deleted path no file list contains can match several features.
   */
  readonly ownersOf: (path: string) => readonly HomeGuideEntry[];
  readonly guide: (path: string) => MappedGuide | undefined;
}

const KEBAB_FEATURE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GLOB_META = /[*?[{]/;
const BACKSLASH = /\\/;

const normalize = (path: string): string => path.replaceAll("\\", "/");

const invalidSourceReason = (source: string): string | undefined => {
  if (source.trim() === "") return "it is empty";
  if (isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source)) return "it is absolute";
  if (BACKSLASH.test(source)) return "it uses a backslash";
  if (source.split("/").includes("..")) return "it leaves the repository with ..";
  if (GLOB_META.test(source)) {
    try {
      new Bun.Glob(source);
    } catch (error) {
      return `Bun.Glob rejects it (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return undefined;
};

const canonicalGuideProblem = (guide: string): string | undefined => {
  if (guide.trim() === "") return "it is empty";
  if (isAbsolute(guide) || /^[A-Za-z]:[\\/]/.test(guide)) return "it is absolute";
  if (BACKSLASH.test(guide)) return "it uses a backslash";
  if (guide.includes("//")) return "it has a doubled slash";
  if (guide.split("/").includes(".")) return "it has a ./ segment";
  if (guide.split("/").includes("..")) return "it leaves the repository with ..";
  if (guide.endsWith("/")) return "it has a trailing slash";
  return undefined;
};

const compareDiagnostics = (left: RegistryDiagnostic, right: RegistryDiagnostic): number =>
  left.code === right.code ? left.message.localeCompare(right.message) : left.code.localeCompare(right.code);

export const validateHomeGuides = (input: ValidateHomeGuidesInput): HomeGuideRegistry => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const add = (code: string, message: string): void => {
    diagnostics.push({ code, message });
  };
  const unmatchedSource = (feature: string, path: string, kind: "source" | "glob"): void => {
    add(
      "registry.unmatched-source",
      `Feature "${feature}" declares the ${kind} "${path}" in scripts/guides/home-guides.ts, but no file git can see matches it. Update or remove that entry in the same change; a rename must update the ${kind === "glob" ? "pattern" : "source path"}.`,
    );
  };

  if (input.entries.length === 0) {
    add(
      "registry.empty",
      "scripts/guides/home-guides.ts declares no features. Add a row for every feature whose sources a guide owns; an empty map is never a pass.",
    );
  }

  const seenFeatures = new Set<string>();
  const seenGuides = new Set<string>();
  const exact = new Map<string, HomeGuideEntry>();
  const globs: Array<{ readonly glob: Bun.Glob; readonly entry: HomeGuideEntry }> = [];
  const claims = new Map<string, HomeGuideEntry>();
  const fileSet = new Set(input.files.map(normalize));

  const claim = (path: string, entry: HomeGuideEntry): void => {
    const previous = claims.get(path);
    if (previous !== undefined && previous.feature !== entry.feature) {
      const [first, second] = [previous.feature, entry.feature].sort();
      add(
        "registry.overlap",
        `"${path}" is covered by two features: "${first}" and "${second}". A covered file has exactly one owner; narrow the sources so only one row matches it.`,
      );
      return;
    }
    claims.set(path, entry);
  };

  for (const entry of input.entries) {
    const problems: Array<string> = [];
    if (!KEBAB_FEATURE.test(entry.feature))
      problems.push(`feature "${entry.feature}" is not a kebab-case id`);
    if (entry.guide.trim() === "") problems.push("guide is missing");
    if (entry.sources.length === 0) problems.push("sources is empty");
    if (problems.length > 0) {
      add(
        "registry.schema",
        `Home-guide entry ${JSON.stringify(entry.feature)} is invalid: ${problems.join("; ")}.`,
      );
      continue;
    }
    if (seenFeatures.has(entry.feature)) {
      add(
        "registry.duplicate-feature",
        `Feature "${entry.feature}" is declared more than once. A feature never has two home guides; add the sources to one row.`,
      );
    }
    seenFeatures.add(entry.feature);
    const guideProblem = canonicalGuideProblem(entry.guide);
    if (guideProblem !== undefined) {
      add(
        "registry.invalid-guide",
        `Feature "${entry.feature}" names the home guide "${entry.guide}", which is not canonical: ${guideProblem}. Use a repository-relative path with / separators and no ./ or ../ segment, doubled slash, or trailing slash.`,
      );
    } else {
      seenGuides.add(entry.guide);
    }

    for (const source of entry.sources) {
      const invalid = invalidSourceReason(source);
      if (invalid !== undefined) {
        add(
          "registry.invalid-source",
          `Feature "${entry.feature}" declares source "${source}", which is invalid: ${invalid}.`,
        );
        continue;
      }
      const path = normalize(source);
      if (!GLOB_META.test(path)) {
        exact.set(path, entry);
        claim(path, entry);
        if (!fileSet.has(path)) unmatchedSource(entry.feature, path, "source");
        continue;
      }
      const glob = new Bun.Glob(path);
      globs.push({ glob, entry });
      let matched = false;
      for (const file of fileSet) {
        if (!glob.match(file)) continue;
        matched = true;
        claim(file, entry);
      }
      if (!matched) unmatchedSource(entry.feature, path, "glob");
    }
  }

  for (const guidePath of seenGuides) {
    if (!input.guides.has(guidePath)) {
      add(
        "registry.unknown-guide",
        `Home guide "${guidePath}" is not returned by guide discovery (docs/guides/**/*.mdx and recipes/<id>/README.mdx). Fix the path or move the page into a discovery root.`,
      );
      continue;
    }
    const parsed = input.guides.get(guidePath);
    if (parsed === undefined) continue;
    if (parsed.kind === "invalid") {
      add("registry.guide-invalid", `Home guide "${guidePath}" does not parse: ${parsed.error}`);
      continue;
    }
    if (parsed.scenarioCount === 0) {
      add(
        "registry.guide-without-scenario",
        `Home guide "${guidePath}" has no <Scenario>. A row needs a scenario that exercises its sources; add one or drop the row.`,
      );
    }
  }

  diagnostics.sort(compareDiagnostics);

  const ownersOf = (path: string): readonly HomeGuideEntry[] => {
    const normalized = normalize(path);
    const literal = exact.get(normalized);
    if (literal !== undefined) return [literal];
    const owners = new Map<string, HomeGuideEntry>();
    for (const { glob, entry } of globs) {
      if (glob.match(normalized)) owners.set(entry.feature, entry);
    }
    return [...owners.values()];
  };

  const guide = (path: string): MappedGuide | undefined => input.guides.get(normalize(path));

  return { entries: input.entries, diagnostics, ownersOf, guide };
};

interface LoadHomeGuideRegistryOptions {
  readonly entries?: readonly HomeGuideEntry[];
}

/** Loads the checked-in map, parses each mapped guide once, and validates it. */
export const loadHomeGuideRegistry = async (
  root: string,
  options: LoadHomeGuideRegistryOptions = {},
): Promise<HomeGuideRegistry> => {
  const entries = options.entries ?? HOME_GUIDES;
  const discovered = await discoverGuideMdxFiles(root);
  const guides = new Map<string, MappedGuide | undefined>(discovered.map((path) => [path, undefined]));
  for (const guidePath of [...new Set(entries.map((entry) => normalize(entry.guide)))].sort()) {
    if (!guides.has(guidePath)) continue;
    try {
      const ast = parseGuideScenarioAst(guidePath, await Bun.file(resolve(root, guidePath)).text());
      guides.set(guidePath, {
        kind: "parsed",
        guideId: ast.frontmatter.id,
        scenarioCount: ast.scenarios.length,
      });
    } catch (error) {
      guides.set(guidePath, {
        kind: "invalid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return validateHomeGuides({ entries, guides, files: await listGitVisibleFiles(root) });
};
