import { sha256Hex } from "@lando/sdk/digest";
export { normalizeAppSlug } from "@lando/sdk/schema";

export const DEFAULT_PROXY_DOMAIN = "lndo.site";

export const shortHash = (input: string): string => sha256Hex(input).slice(0, 8);

export const kebab = (raw: string): string => {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length === 0 ? "shadow" : ascii;
};

export const appNetworkName = (slug: string): string => `lando-${slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");
