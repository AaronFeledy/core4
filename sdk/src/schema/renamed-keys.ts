/**
 * Removed authored spellings from N1/N2/N3a. Nothing decodes these keys; each
 * produces one `key.renamed` finding that names the canonical spelling.
 *
 * Ownership: this table owns every listed spelling, including `dockerfileInline`
 * (not `build.unsupported-key`) and every camelCase Compose twin. The Compose
 * rejection pass never lists these paths, so it cannot double-report them.
 * Native endpoint `appProtocol`, plan `workingDirectory`/`dependsOn`, and
 * `appMount.readOnly` stay valid and are outside this table.
 */
import { Predicate } from "effect";

/**
 * Path patterns ending in the removed key. `*` matches one segment (service name,
 * list index, or nested map key). First match wins; keep more specific paths first.
 */
const RENAMED_CONFIG_KEY_PATHS = [
  { path: ["services", "*", "workingDirectory"], canonical: "working_dir" },
  { path: ["services", "*", "envFile"], canonical: "env_file" },
  { path: ["services", "*", "dependsOn"], canonical: "depends_on" },
  {
    path: ["services", "*", "depends_on", "[]"],
    canonical: "depends_on",
    isRemovedForm: (value: unknown) => Predicate.isObject(value) && Object.hasOwn(value, "service"),
    message: "depends_on no longer accepts a list of dependency objects.",
    suggestion: "Use a list of service names or a depends_on condition map keyed by service name.",
  },
  { path: ["services", "*", "ports", "*", "hostIp"], canonical: "host_ip" },
  { path: ["services", "*", "ports", "*", "appProtocol"], canonical: "app_protocol" },
  { path: ["services", "*", "volumes", "*", "readOnly"], canonical: "read_only" },
  { path: ["services", "*", "volumes", "*", "createHostPath"], canonical: "bind.create_host_path" },
  { path: ["services", "*", "volumes", "*", "subpath"], canonical: "volume.subpath" },
  {
    path: ["services", "*", "volumes", "*", "bind", "createHostPath"],
    canonical: "create_host_path",
  },
  { path: ["services", "*", "build", "dockerfileInline"], canonical: "dockerfile_inline" },
  { path: ["services", "*", "db_client"], canonical: "dbClient" },
  { path: ["services", "*", "scanner", "timeout"], canonical: "timeoutMs" },
  { path: ["services", "*", "healthcheck", "startInterval"], canonical: "startIntervalSeconds" },
  { path: ["services", "*", "readiness", "startInterval"], canonical: "startIntervalSeconds" },
  { path: ["env_file"], canonical: "serviceDefaults.env_file" },
  { path: ["appEnv"], canonical: "serviceDefaults.environment" },
  { path: ["appLabels"], canonical: "serviceDefaults.labels" },
  { path: ["scanner", "timeout"], canonical: "timeoutMs" },
] as const satisfies ReadonlyArray<{
  readonly path: ReadonlyArray<string>;
  readonly canonical: string;
  readonly isRemovedForm?: (value: unknown) => boolean;
  readonly message?: string;
  readonly suggestion?: string;
}>;

const matchesPath = (actual: ReadonlyArray<string | number>, pattern: ReadonlyArray<string>): boolean =>
  actual.length === pattern.length &&
  pattern.every((segment, index) => {
    if (segment === "*") return true;
    if (segment === "[]") return typeof actual[index] === "number";
    return String(actual[index]) === segment;
  });

/** Attach `key.renamed` reason, message, and suggestion when the leaf path is a removed spelling. */
export const applyRenamedConfigKey = <
  T extends {
    readonly path: ReadonlyArray<string | number | symbol>;
    readonly message: string;
    readonly reason?: string;
    readonly suggestion?: string;
  },
>(
  leaf: T,
  authored: unknown,
): T => {
  const path = leaf.path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
  for (const entry of RENAMED_CONFIG_KEY_PATHS) {
    if (!matchesPath(path, entry.path)) continue;
    if ("isRemovedForm" in entry && !entry.isRemovedForm(authored)) continue;
    const removed = path.at(-1);
    return {
      ...leaf,
      reason: "key.renamed",
      message: "message" in entry ? entry.message : `"${removed}" was renamed to "${entry.canonical}".`,
      suggestion: "suggestion" in entry ? entry.suggestion : `Rename ${removed} to ${entry.canonical}.`,
    };
  }
  return leaf;
};
