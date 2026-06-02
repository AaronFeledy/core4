import { RecipeFetchNotAllowedError } from "@lando/sdk/errors";

export const DEFAULT_FETCH_ALLOWLIST: ReadonlyArray<string> = ["*"];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 20;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const urlGlobToRegExp = (glob: string): RegExp => {
  let pattern = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 2;
      } else {
        pattern += "[^/]*";
        index += 1;
      }
    } else {
      pattern += escapeRegExp(char);
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
};

export const matchesUrlGlob = (glob: string, url: string): boolean => urlGlobToRegExp(glob).test(url);

export type FetchPermission =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly allowlist: ReadonlyArray<string> }
  | { readonly kind: "warn"; readonly allowlist: ReadonlyArray<string> };

export const evaluateFetchPermission = (
  allowlist: ReadonlyArray<string> | undefined,
  url: string,
): FetchPermission => {
  if (allowlist === undefined) return { kind: "warn", allowlist: DEFAULT_FETCH_ALLOWLIST };
  return allowlist.some((glob) => matchesUrlGlob(glob, url))
    ? { kind: "allowed" }
    : { kind: "denied", allowlist };
};

const formatAllowlist = (allowlist: ReadonlyArray<string>): string =>
  allowlist.length === 0 ? "<empty>" : allowlist.join(", ");

export const fetchNotAllowedError = (
  url: string,
  allowlist: ReadonlyArray<string>,
  options: { readonly recipe?: string; readonly viaRedirect?: boolean } = {},
): RecipeFetchNotAllowedError =>
  new RecipeFetchNotAllowedError({
    message: `Recipe fetch to "${url}" is not in the recipe's fetchAllowlist.`,
    url,
    allowlist: [...allowlist],
    remediation: `Allowed URL globs are: ${formatAllowlist(allowlist)}. Add a matching glob to the recipe.yml fetchAllowlist: or remove the ctx.fetch call to "${url}".`,
    ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
    ...(options.viaRedirect === undefined ? {} : { viaRedirect: options.viaRedirect }),
  });

export const defaultFetchWarning = (url: string, _allowlist: ReadonlyArray<string>): string =>
  `Recipe fetched "${url}" with no fetchAllowlist declared; add a fetchAllowlist: to your recipe to verify the hosts it contacts.`;

export interface RecipeFetchContext {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export const createRecipeFetchContext = (options: {
  readonly allowlist: ReadonlyArray<string> | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly onWarn?: (message: string) => void;
  readonly recipe?: string;
  readonly maxRedirects?: number;
}): RecipeFetchContext => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const guard = (url: string, viaRedirect: boolean): void => {
    const permission = evaluateFetchPermission(options.allowlist, url);
    if (permission.kind === "denied")
      throw fetchNotAllowedError(url, permission.allowlist, {
        ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
        ...(viaRedirect ? { viaRedirect: true } : {}),
      });
    if (permission.kind === "warn") options.onWarn?.(defaultFetchWarning(url, permission.allowlist));
  };

  return {
    fetch: async (input, init) => {
      let currentUrl = typeof input === "string" ? input : input.toString();
      let redirects = 0;
      while (true) {
        guard(currentUrl, redirects > 0);
        const response = await fetchImpl(currentUrl, { ...init, redirect: "manual" });
        if (!REDIRECT_STATUSES.has(response.status)) return response;
        const location = response.headers.get("location");
        if (location === null) return response;
        redirects += 1;
        if (redirects > maxRedirects)
          throw new Error(
            `Recipe fetch to "${currentUrl}" exceeded the maximum of ${maxRedirects} redirects.`,
          );
        currentUrl = new URL(location, currentUrl).toString();
      }
    },
  };
};
