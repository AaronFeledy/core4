export const BUN_SHELL_SCRIPT_EXTENSION = ".bun.sh";

const sanitizeSegment = (segment: string): string =>
  segment
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

export const canonicalIdFromRelativePath = (relativePath: string): { name: string; id: string } | null => {
  if (!relativePath.endsWith(BUN_SHELL_SCRIPT_EXTENSION)) return null;
  const segments = relativePath
    .slice(0, -BUN_SHELL_SCRIPT_EXTENSION.length)
    .split(/[\\/]/)
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const name = segments.join(":");
  return { name, id: `app:${name}` };
};
