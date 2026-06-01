import { RecipeSourceError } from "@lando/sdk/errors";

export interface InitSourceFlags {
  readonly source?: string | undefined;
  readonly url?: string | undefined;
  readonly path?: string | undefined;
}

export interface ParsedInitSourceFlags {
  readonly source?: "git";
  readonly url?: string;
  readonly path?: string;
}

export const parseInitSourceFlags = (flags: InitSourceFlags): ParsedInitSourceFlags => {
  if (flags.source === undefined || flags.source.trim() === "") return {};
  if (flags.source !== "git") {
    throw new RecipeSourceError({
      message: `Unsupported init source "${flags.source}".`,
      source: flags.source,
      kind: "unsupported-source",
      remediation:
        "Use --source=git with --url=<git-url>; other recipe source flags are not implemented yet.",
    });
  }
  if (flags.url === undefined || flags.url.trim() === "") {
    throw new RecipeSourceError({
      message: "lando init --source=git requires --url=<git-url>.",
      source: "git",
      kind: "missing-url",
      remediation: "Pass --url=<git-url> with --source=git.",
    });
  }
  return { source: "git", url: flags.url, ...(flags.path === undefined ? {} : { path: flags.path }) };
};
