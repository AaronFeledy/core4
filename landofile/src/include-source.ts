import { isAbsolute, relative, resolve } from "node:path";
import type { IncludeEntry, LandofileShape } from "@lando/sdk/schema";
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
        ...(entry.checksum === undefined ? {} : { checksum: entry.checksum }),
      };
export const authoredIncludeEntries = (
  landofile: Pick<LandofileShape, "include" | "includes">,
): ReadonlyArray<IncludeEntry> => [
  ...(landofile.includes ?? []).filter((entry) => typeof entry === "string" || entry.kind !== "tooling"),
  ...(landofile.include ?? []),
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
  const normalized = relative(".", resolve(".", slashPath));
  if (normalized === "" || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized))
    throw includeError({
      message: `Include subpath escapes the source root: ${subpath}`,
      source,
      kind: "subpath-invalid",
    });
  return normalized;
};
const parseSourceRef = (raw: string): { readonly value: string; readonly ref?: string } => {
  const at = raw.lastIndexOf("@");
  if (at <= 0) return { value: raw };
  if (raw.startsWith("git@") && raw.indexOf(":") < at) return { value: raw };
  const ref = raw.slice(at + 1);
  return ref === "" ? { value: raw } : { value: raw.slice(0, at), ref };
};
export const classify = (source: string): "local" | "user" | "git" | "npm" => {
  if (source.startsWith("user:")) return "user";
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git@") || source.startsWith("github:") || /^https?:\/\//u.test(source)) return "git";
  return "local";
};
const gitHubPathFromSource = (source: string): string | undefined => {
  if (!source.startsWith("github:")) return undefined;
  const parts = source.slice("github:".length).split("/");
  return parts.length > 2 ? parts.slice(2).join("/") : undefined;
};
const gitCloneUrl = (source: string): string => {
  if (!source.startsWith("github:")) return source;
  const [owner, repo] = source.slice("github:".length).split("/");
  return owner === undefined || repo === undefined ? source : `https://github.com/${owner}/${repo}.git`;
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
  const parsed = parseSourceRef(entry.source);
  const path = safeRelativeSubpath(entry.path ?? gitHubPathFromSource(parsed.value), entry.source);
  const ref = entry.version ?? parsed.ref;
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
  const parsed = parseSourceRef(entry.source.slice("npm:".length));
  const requestedVersion = entry.version ?? parsed.ref;
  const parts = parsed.value.split("/");
  const packageName = parsed.value.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  const subpath =
    entry.path ?? (parsed.value.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/"));
  const packageSpec = requestedVersion === undefined ? packageName : `${packageName}@${requestedVersion}`;
  return {
    sourceId: `npm:${parsed.value}`,
    packageSpec,
    packageName,
    ...(requestedVersion === undefined ? {} : { requestedVersion }),
    path: safeRelativeSubpath(subpath, entry.source),
  };
};
