export const splitSourceRef = (raw: string): { readonly value: string; readonly ref?: string } => {
  const at = raw.lastIndexOf("@");
  if (at <= 0) return { value: raw };
  const authority = raw.indexOf("://");
  const boundary =
    authority >= 0 ? raw.indexOf("/", authority + 3) : raw.startsWith("git@") ? raw.indexOf(":") : 0;
  if (boundary < 0 || at <= boundary) return { value: raw };
  const ref = raw.slice(at + 1);
  return ref === "" ? { value: raw } : { value: raw.slice(0, at), ref };
};

export const isGitSource = (source: string): boolean =>
  source.startsWith("git@") || source.startsWith("github:") || /^(?:git\+)?(?:https?|ssh):\/\//u.test(source);

export const gitCloneUrl = (source: string): string => {
  if (!source.startsWith("github:")) return source.replace(/^git\+/u, "");
  const [owner, repo] = source.slice("github:".length).split("/");
  return owner === undefined || repo === undefined ? source : `https://github.com/${owner}/${repo}.git`;
};

// git check-ref-format rules for one literal ref (a full SHA also passes). A
// leading "-" or "+" would otherwise reach git fetch as an option or refspec.
const INVALID_REF_PATTERNS = [
  /^$/u,
  /^@$/u,
  /^[+/-]/u,
  /[\p{Cc}\s~^:?*[\\]/u,
  /\.\./u,
  /\/\//u,
  /@\{/u,
  /[/.]$/u,
  /(?:^|\/)\./u,
  /\.lock(?:\/|$)/u,
] as const;
export const isLiteralGitRef = (ref: string): boolean =>
  !INVALID_REF_PATTERNS.some((pattern) => pattern.test(ref));
