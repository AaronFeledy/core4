import { isAbsolute, posix } from "node:path";
import type { IncludeEntry, LandofileShape } from "@lando/sdk/schema";
import { gitCloneUrl, isGitSource, isLiteralGitRef, splitSourceRef } from "./git-ref.ts";
import type { NormalizedInclude } from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import { hasToolingIncludes } from "./tooling-include-entries.ts";

export const normalizeInclude = (entry: IncludeEntry): NormalizedInclude =>
  typeof entry === "string"
    ? { source: entry }
    : {
        source: entry.source,
        ...(entry.path === undefined ? {} : { path: entry.path }),
        ...(entry.version === undefined ? {} : { version: entry.version }),
      };
export const authoredIncludeEntries = (
  landofile: Pick<LandofileShape, "include" | "includes">,
): ReadonlyArray<IncludeEntry> => authoredIncludeEntriesWithPaths(landofile).map(({ entry }) => entry);
export const authoredIncludeEntriesWithPaths = (landofile: Pick<LandofileShape, "include" | "includes">) => [
  ...(landofile.includes ?? []).flatMap((entry, index) =>
    typeof entry === "string" || entry.kind !== "tooling"
      ? [{ entry, path: ["includes", index] as const }]
      : [],
  ),
  ...(landofile.include ?? []).map((entry, index) => ({ entry, path: ["include", index] as const })),
];
export const hasResolvableIncludes = (
  landofile: Pick<LandofileShape, "include" | "includes" | "toolingIncludes">,
): boolean => authoredIncludeEntries(landofile).length > 0 || hasToolingIncludes(landofile);

const safeRelativeSubpath = (subpath: string | undefined, source: string): string => {
  if (subpath === undefined || subpath.trim() === "")
    throw includeError({
      message: `Remote include ${source} must specify a fragment path.`,
      source,
      kind: "subpath-invalid",
      remediation: "Set includes[].path to a relative YAML fragment path inside the remote source.",
    });
  const slashPath = subpath.replace(/\\/gu, "/");
  if (isAbsolute(subpath) || slashPath.startsWith("/"))
    throw includeError({
      message: `Include subpath must be relative: ${subpath}`,
      source,
      kind: "subpath-invalid",
    });
  const normalized = posix.relative("/", posix.resolve("/", slashPath));
  if (
    normalized === "" ||
    posix.normalize(slashPath).startsWith("../") ||
    slashPath === ".." ||
    /^[A-Za-z]:/u.test(slashPath)
  )
    throw includeError({
      message: `Include subpath escapes the source root: ${subpath}`,
      source,
      kind: "subpath-invalid",
    });
  return normalized;
};
export const classify = (source: string): "local" | "user" | "git" | "npm" => {
  if (source.startsWith("user:")) return "user";
  if (source.startsWith("npm:")) return "npm";
  if (isGitSource(source)) return "git";
  return "local";
};
const gitHubPathFromSource = (source: string): string | undefined => {
  if (!source.startsWith("github:")) return undefined;
  const parts = source.slice("github:".length).split("/");
  return parts.length > 2 ? parts.slice(2).join("/") : undefined;
};
const gitRepoIdentity = (source: string): string => {
  if (!source.startsWith("github:")) return source;
  const [owner, repo] = source.slice("github:".length).split("/");
  return owner === undefined || repo === undefined ? source : `github:${owner}/${repo}`;
};
export const parseGitInclude = (
  entry: NormalizedInclude,
): {
  readonly sourceId: string;
  readonly cloneUrl: string;
  readonly path: string;
  readonly ref?: string;
} => {
  const parsed = splitSourceRef(entry.source);
  const path = safeRelativeSubpath(entry.path ?? gitHubPathFromSource(parsed.value), entry.source);
  const ref = entry.version ?? parsed.ref;
  if (ref !== undefined && !isLiteralGitRef(ref))
    throw includeError({
      message: `Invalid git include ref ${ref} for ${entry.source}.`,
      source: entry.source,
      kind: "source-unresolved",
      remediation: "Use a valid git tag, branch, or full commit SHA.",
    });
  return {
    sourceId: `${gitRepoIdentity(parsed.value)}/${path}`,
    cloneUrl: gitCloneUrl(parsed.value),
    path,
    ...(ref === undefined ? {} : { ref }),
  };
};
export const parseNpmInclude = (
  entry: NormalizedInclude,
): {
  readonly sourceId: string;
  readonly packageSpec: string;
  readonly packageName: string;
  readonly requestedVersion?: string;
  readonly path: string;
} => {
  const parsed = splitSourceRef(entry.source.slice("npm:".length));
  const requestedVersion = entry.version ?? parsed.ref;
  const parts = parsed.value.split("/");
  const packageName = parsed.value.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  const subpath =
    entry.path ?? (parsed.value.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/"));
  const packageSpec = requestedVersion === undefined ? packageName : `${packageName}@${requestedVersion}`;
  const path = safeRelativeSubpath(subpath, entry.source);
  return {
    sourceId: `npm:${packageName}/${path}`,
    packageSpec,
    packageName,
    ...(requestedVersion === undefined ? {} : { requestedVersion }),
    path,
  };
};
