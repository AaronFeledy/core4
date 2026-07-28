import { resolve } from "node:path";

import { createInventory } from "./inventory.ts";
import type {
  ApplyExceptions,
  ArchitectureException,
  ArchitectureRuleId,
  AuditExceptions,
  ExceptionStaleness,
  InventorySelector,
} from "./types.ts";

const ALLOW_UNUSED = "allow" as const;
const ERROR_UNUSED = "error" as const;

export const ARCHITECTURE_EXCEPTIONS: ReadonlyArray<ArchitectureException> = [
  {
    ruleId: "renderer-boundary",
    path: "core/bin/lando.ts",
    kind: "file",
    category: "carve-out",
    rationale: "outside scan roots; listed for documentation parity",
    removalCondition: "Remove when the renderer rule scans core/bin.",
    unusedPolicy: ALLOW_UNUSED,
    skipMissingAudit: true,
  },
  {
    ruleId: "renderer-boundary",
    path: "core/src/cli/oclif/pre-renderer.ts",
    kind: "file",
    category: "carve-out",
    rationale: "Legacy renderer boundary carve-out for cold-start pre-rendering.",
    removalCondition: "Remove when pre-command output no longer requires the Effect-free renderer bootstrap.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "renderer-boundary",
    path: "core/src/interaction/service.ts",
    kind: "file",
    category: "carve-out",
    rationale:
      "Live-layer prompt IO owns stdin and the no-renderer fallback writer; prompt output otherwise routes through Renderer.output.",
    removalCondition:
      "Remove when prompt IO can route its fallback writer through Renderer without a dependency cycle.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "managed-file-boundary",
    path: "core/src/managed-file/",
    kind: "prefix",
    category: "owner",
    rationale:
      "Sentinels of the one ownership-marker/overwrite implementation. A host-project file writer that re-spells these is hand-rolling managed-file logic instead of delegating to `ManagedFileService`. `x-lando-generated` is caught by the `lando-generated` tag, and the fences are the `block`-mode markers.",
    removalCondition: "never — this is the primitive",
    unusedPolicy: ERROR_UNUSED,
  },
  {
    ruleId: "state-store-boundary",
    path: "core/src/state/",
    kind: "prefix",
    category: "owner",
    rationale: "Durable atomic-write + lockfile + version-envelope logic must route through core/src/state/.",
    removalCondition: "never — this is the primitive",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "state-store-boundary",
    path: "core/src/cache/atomic.ts",
    kind: "file",
    category: "carve-out",
    rationale:
      "Low-level shared atomic cache helper; callers must not re-spell the full StateStore lock + version-envelope contract around it.",
    removalCondition: "Remove when cache atomic writes route through StateStore.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "state-store-boundary",
    path: "core/src/landofile/includes.ts",
    kind: "file",
    category: "carve-out",
    rationale:
      "Include lockfile and scratch registry use StateStore-backed codecs rather than owning durable state persistence directly.",
    removalCondition: "Remove when include lockfile code contains no state-store boundary signals.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "state-store-boundary",
    path: "core/src/scratch-app/registry.ts",
    kind: "file",
    category: "carve-out",
    rationale:
      "Include lockfile and scratch registry use StateStore-backed codecs rather than owning durable state persistence directly.",
    removalCondition: "Remove when scratch registry code contains no state-store boundary signals.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "state-store-boundary",
    path: "core/src/state-store/atomic.ts",
    kind: "file",
    category: "carve-out",
    rationale: "Canonical StateStore-compatible low-level atomic helper.",
    removalCondition: "Remove when the helper moves under the StateStore owner prefix.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "probe-boundary",
    path: "core/src/state/lock.ts",
    kind: "file",
    category: "carve-out",
    rationale:
      "Pre-existing non-probe retry/Schedule uses are explicitly allowlisted so the gate locks the single retry/backoff/verdict primitive (@lando/sdk/probe) for host/provider-shaped probing without blocking unrelated synchronization. Advisory state lockfile acquisition: a bounded retry on O_EXCL contention, not a probe-to-verdict loop.",
    removalCondition:
      "Remove when advisory lock acquisition no longer resembles a forbidden retry primitive.",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "network-boundary",
    path: "core/src/http-client/live.ts",
    kind: "file",
    category: "owner",
    rationale:
      "The one place a direct global fetch is allowed: the HttpClient adapter itself, which is the canonical egress boundary every other call site routes through.",
    removalCondition: "never — this is the primitive",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "paths-boundary",
    path: "core/src/config/paths.ts",
    kind: "file",
    category: "owner",
    rationale: "The single primitive module is the only place these root joins may live.",
    removalCondition: "never — this is the primitive",
    unusedPolicy: ALLOW_UNUSED,
  },
  {
    ruleId: "package-dag",
    path: "core/src/plugins/generated/",
    kind: "prefix",
    category: "owner",
    rationale: "Generated composition root where core is allowed to import bundled plugin packages.",
    removalCondition: "never — this is the primitive",
    unusedPolicy: ERROR_UNUSED,
  },
];

const RULE_SELECTORS = {
  "renderer-boundary": "core-and-plugin-sources",
  "managed-file-boundary": "core-and-plugin-sources",
  "redaction-boundary": "core-and-plugin-sources",
  "env-helper-boundary": "service-lando-services",
  "package-dag": "workspace-runtime-sources",
  "paths-boundary": "core-and-plugin-sources",
  "state-store-boundary": "core-and-plugin-sources",
  "probe-boundary": "core-and-plugin-sources",
  "network-boundary": "core-and-plugin-sources",
  "import-cycle": "workspace-runtime-sources",
} satisfies Readonly<Record<ArchitectureRuleId, InventorySelector>>;

export const isExceptionMatch = (exception: ArchitectureException, fileRelPath: string): boolean => {
  switch (exception.kind) {
    case "file":
      return fileRelPath === exception.path;
    case "prefix":
      return fileRelPath.startsWith(exception.path);
  }
};

export const applyExceptions: ApplyExceptions = (diagnostics, exceptions) => {
  const usedExceptions = new Set<ArchitectureException>();
  const kept = diagnostics.filter((diagnostic) => {
    const matches = exceptions.filter(
      (exception) => exception.ruleId === diagnostic.ruleId && isExceptionMatch(exception, diagnostic.file),
    );
    for (const exception of matches) usedExceptions.add(exception);
    return matches.length === 0;
  });
  return { diagnostics: kept, usedExceptions };
};

export const auditExceptions: AuditExceptions = async (root, exceptions, usedExceptions, activeRuleIds) => {
  const inventory = createInventory(root);
  const relativePaths = new Map<InventorySelector, ReadonlyArray<string>>();
  const stale: ExceptionStaleness[] = [];
  const active = activeRuleIds === undefined ? undefined : new Set<ArchitectureRuleId>(activeRuleIds);

  for (const exception of exceptions) {
    if (active !== undefined && !active.has(exception.ruleId)) continue;
    const selector = RULE_SELECTORS[exception.ruleId];
    let paths = relativePaths.get(selector);
    if (paths === undefined) {
      paths = (await inventory.files(selector)).map(({ relativePath }) => relativePath);
      relativePaths.set(selector, paths);
    }
    const present = paths.some((path) => isExceptionMatch(exception, path));
    if (!present && exception.skipMissingAudit !== true) {
      stale.push({
        kind: "stale-missing",
        exception,
        message: `${exception.path} is absent from the ${selector} inventory.`,
      });
    }
    if (!usedExceptions.has(exception) && exception.unusedPolicy !== ALLOW_UNUSED) {
      stale.push({
        kind: "stale-unused",
        exception,
        message: `${exception.path} suppressed no ${exception.ruleId} diagnostics.`,
      });
    }
  }

  return stale;
};

export const shouldAuditExceptions = (root: string, repoRoot: string): boolean => root === repoRoot;

export const defaultRepoRoot = (): string => resolve(import.meta.dirname, "../..");
