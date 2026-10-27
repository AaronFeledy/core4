// ============================================================================
// Pure Docker Hub alias normalization; other registry references remain intact.
// ============================================================================

export const canonicalImageReference = (ref: string): string => {
  const slash = ref.indexOf("/");
  const first = slash < 0 ? ref : ref.slice(0, slash);
  const explicitRegistry = slash >= 0 && (/[.:]/u.test(first) || first === "localhost");
  const registry = explicitRegistry ? first : "docker.io";
  const hub = ["docker.io", "index.docker.io", "registry-1.docker.io"].includes(registry);
  let name = explicitRegistry ? ref.slice(slash + 1) : ref;
  if (hub && !name.includes("/")) name = `library/${name}`;
  const tagged = name.slice(name.lastIndexOf("/") + 1).includes(":");
  const suffix = tagged || name.includes("@") ? "" : ":latest";
  return `${hub ? "docker.io" : registry}/${name}${suffix}`;
};

export const sameImageReference = (a: string, b: string): boolean =>
  canonicalImageReference(a) === canonicalImageReference(b);
