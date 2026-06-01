import { RecipeSourceError } from "@lando/sdk/errors";

export interface InitSourceFlags {
  readonly source?: string | undefined;
  readonly url?: string | undefined;
  readonly path?: string | undefined;
  readonly checksum?: string | undefined;
}

export interface ParsedInitSourceFlags {
  readonly source?: "git" | "tarball";
  readonly url?: string;
  readonly path?: string;
  readonly checksum?: string;
}

const REMOTE_SOURCES = new Set(["git", "tarball"]);

export const parseInitSourceFlags = (flags: InitSourceFlags): ParsedInitSourceFlags => {
  if (flags.source === undefined || flags.source.trim() === "") return {};
  if (!REMOTE_SOURCES.has(flags.source)) {
    throw new RecipeSourceError({
      message: `Unsupported init source "${flags.source}".`,
      source: flags.source,
      kind: "unsupported-source",
      remediation:
        "Use --source=git or --source=tarball with --url=<url>; other recipe source flags are not implemented yet.",
    });
  }
  if (flags.url === undefined || flags.url.trim() === "") {
    const urlLabel = flags.source === "git" ? "<git-url>" : "<tarball-url>";
    throw new RecipeSourceError({
      message: `lando init --source=${flags.source} requires --url=${urlLabel}.`,
      source: flags.source,
      kind: "missing-url",
      remediation: `Pass --url=${urlLabel} with --source=${flags.source}.`,
    });
  }
  const source = flags.source as "git" | "tarball";
  return {
    source,
    url: flags.url,
    ...(flags.path === undefined ? {} : { path: flags.path }),
    ...(source === "tarball" && flags.checksum !== undefined && flags.checksum.trim() !== ""
      ? { checksum: flags.checksum }
      : {}),
  };
};
