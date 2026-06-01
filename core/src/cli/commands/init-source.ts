import { RecipeSourceError } from "@lando/sdk/errors";

export interface InitSourceFlags {
  readonly source?: string | undefined;
  readonly url?: string | undefined;
  readonly package?: string | undefined;
  readonly id?: string | undefined;
  readonly path?: string | undefined;
  readonly checksum?: string | undefined;
}

export interface ParsedInitSourceFlags {
  readonly source?: "git" | "tarball" | "npm" | "registry";
  readonly url?: string;
  readonly package?: string;
  readonly id?: string;
  readonly path?: string;
  readonly checksum?: string;
}

const REMOTE_SOURCES = new Set(["git", "tarball", "npm", "registry"]);

export const parseInitSourceFlags = (flags: InitSourceFlags): ParsedInitSourceFlags => {
  if (flags.source === undefined || flags.source.trim() === "") return {};
  if (!REMOTE_SOURCES.has(flags.source)) {
    throw new RecipeSourceError({
      message: `Unsupported init source "${flags.source}".`,
      source: flags.source,
      kind: "unsupported-source",
      remediation:
        "Use --source=git/--source=tarball with --url=<url>, --source=npm with --package=<name>, or --source=registry with --id=<recipe-id>; other recipe source flags are not implemented yet.",
    });
  }
  const source = flags.source as "git" | "tarball" | "npm" | "registry";
  if (source === "npm") {
    if (flags.package === undefined || flags.package.trim() === "") {
      throw new RecipeSourceError({
        message: "lando init --source=npm requires --package=<name>[@version].",
        source: flags.source,
        kind: "missing-package",
        remediation: "Pass --package=<name>[@version] with --source=npm.",
      });
    }
    return {
      source,
      package: flags.package,
      ...(flags.path === undefined ? {} : { path: flags.path }),
    };
  }
  if (source === "registry") {
    if (flags.id === undefined || flags.id.trim() === "") {
      throw new RecipeSourceError({
        message: "lando init --source=registry requires --id=<recipe-id>.",
        source: flags.source,
        kind: "missing-id",
        remediation: "Pass --id=<recipe-id> with --source=registry.",
      });
    }
    return {
      source,
      id: flags.id,
      ...(flags.path === undefined ? {} : { path: flags.path }),
    };
  }
  if (flags.url === undefined || flags.url.trim() === "") {
    const urlLabel = source === "git" ? "<git-url>" : "<tarball-url>";
    throw new RecipeSourceError({
      message: `lando init --source=${source} requires --url=${urlLabel}.`,
      source: flags.source,
      kind: "missing-url",
      remediation: `Pass --url=${urlLabel} with --source=${source}.`,
    });
  }
  return {
    source,
    url: flags.url,
    ...(flags.path === undefined ? {} : { path: flags.path }),
    ...(source === "tarball" && flags.checksum !== undefined && flags.checksum.trim() !== ""
      ? { checksum: flags.checksum }
      : {}),
  };
};
