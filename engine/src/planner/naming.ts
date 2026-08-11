import { createHash } from "node:crypto";

export const DEFAULT_PROXY_DOMAIN = "lndo.site";

export const APP_SLUG_MAX_LENGTH = 57;

export const shortHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 8);

export const normalizeAppSlug = (name: string, appRoot: string): string => {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, APP_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return normalized.length > 0 ? normalized : shortHash(appRoot);
};

export const kebab = (raw: string): string => {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length === 0 ? "shadow" : ascii;
};

export const appNetworkName = (slug: string): string => `lando-${slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");
