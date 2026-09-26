import { isLegacyTagged } from "@lando/sdk/landofile";
import {
  type ConfigTranslateDiagnostic,
  type ConfigTranslateOutput,
  ConfigTranslateSourceId,
  type LandofileLayer,
} from "@lando/sdk/schema";
import {
  type Lando3Path,
  type Lando3Source,
  type LegacyOccurrence,
  lando3SourceLayerOrder,
  lando3TargetLayer,
} from "./contract.ts";
import { type V4Wire, asStringArray, isPlainObject } from "./lowering-contract.ts";
import { slugifyAppName } from "./naming.ts";

const nameAssignments = (
  sources: ReadonlyArray<Lando3Source>,
): ReadonlyArray<{ readonly source: Lando3Source; readonly name: string }> =>
  sources.flatMap((source) => {
    const root = source.value;
    if (root?.kind !== "mapping") return [];
    const entry = root.entries.get("name");
    if (entry?.kind !== "scalar" || typeof entry.value !== "string") return [];
    return [{ source, name: entry.value }];
  });

export const lowerAppNames = (
  sources: ReadonlyArray<Lando3Source>,
  writable: ReadonlySet<LandofileLayer>,
): ReadonlyArray<ConfigTranslateOutput> => {
  const byTarget = new Map<
    LandofileLayer,
    { readonly sourceIds: Array<ConfigTranslateSourceId>; name: string; order: number }
  >();
  for (const { source, name } of nameAssignments(sources)) {
    const target = lando3TargetLayer(source.layer);
    if (!writable.has(target)) continue;
    const order = lando3SourceLayerOrder(source.layer);
    const existing = byTarget.get(target);
    if (existing === undefined) {
      byTarget.set(target, { sourceIds: [source.sourceId], name, order });
      continue;
    }
    existing.sourceIds.push(source.sourceId);
    // Two Lando 3 layers can fold onto one target. Later Lando 3 order wins,
    // exactly as it would have at load time.
    if (order >= existing.order) {
      existing.name = name;
      existing.order = order;
    }
  }
  return [...byTarget.entries()].map(([targetLayer, claim]) => ({
    targetLayer,
    fragment: { name: slugifyAppName(claim.name) },
    sourceIds: claim.sourceIds,
  }));
};

export interface TopLevelContext {
  readonly fallbackSourceId: string;
  readonly occurrenceAt: (path: Lando3Path) => LegacyOccurrence | undefined;
}

export interface TopLevelResult {
  readonly fragment: V4Wire;
  readonly appMountExcludes: ReadonlyArray<string>;
  readonly appMountIncludes: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
}

export const lowerTopLevel = (document: Record<string, unknown>, ctx: TopLevelContext): TopLevelResult => {
  const fragment: Record<string, unknown> = {};
  const appMountExcludes: string[] = [];
  const appMountIncludes: string[] = [];
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const report = (
    keyPath: Lando3Path,
    detail: Pick<ConfigTranslateDiagnostic, "kind" | "message" | "remediation">,
  ): void => {
    const occurrence = ctx.occurrenceAt(keyPath);
    const span = occurrence?.span;
    diagnostics.push({
      ...detail,
      keyPath,
      sourceId: occurrence?.sourceId ?? ConfigTranslateSourceId.make(ctx.fallbackSourceId),
      ...(span === undefined
        ? {}
        : {
            span: {
              start: { line: span.start.line, column: span.start.column },
              end: { line: span.end.line, column: span.end.column },
            },
          }),
    });
  };

  for (const [key, value] of Object.entries(document)) {
    switch (key) {
      case "compose": {
        const entries: readonly unknown[] = Array.isArray(value) ? value : [value];
        const includes: Array<{ readonly source: string; readonly kind: "compose" }> = [];
        entries.forEach((entry, index) => {
          if (isLegacyTagged(entry) || typeof entry !== "string") {
            report([key, index], {
              kind: "unsupported",
              message: "Compose includes must be plain paths; tagged references are not resolved.",
              remediation: "Replace this entry with an app-relative Compose file path.",
            });
            return;
          }
          let depth = 0;
          let escapesRoot = /^[\\/]|^[a-z]:[\\/]/i.test(entry);
          for (const segment of entry.split(/[\\/]/)) {
            if (segment === "..") {
              depth -= 1;
              if (depth < 0) escapesRoot = true;
            } else if (segment !== "" && segment !== ".") {
              depth += 1;
            }
          }
          includes.push({ source: entry, kind: "compose" });
          report(
            [key, index],
            escapesRoot
              ? {
                  kind: "unsupported",
                  message:
                    "Compose include is absolute or escapes the app root; retained for core safety validation.",
                  remediation: "Move the Compose file inside the app root and use an app-relative path.",
                }
              : {
                  kind: "rewritten",
                  message: "Compose file path moved to includes with kind compose.",
                  remediation: "Review the Compose include before starting the app.",
                },
          );
        });
        if (includes.length > 0) fragment.includes = includes;
        break;
      }
      case "excludes":
        for (const pattern of asStringArray(value) ?? []) {
          if (pattern.startsWith("!")) appMountIncludes.push(pattern.slice(1));
          else appMountExcludes.push(pattern);
        }
        report([key], {
          kind: "rewritten",
          message: "Top-level excludes moved to service appMount.excludes and appMount.includes.",
          remediation: "Apply these patterns to each app-mounted service and review negated includes.",
        });
        break;
      case "plugins":
      case "pluginDirs":
        report([key], {
          kind: "dropped",
          message: `Per-app Lando 3 ${key === "plugins" ? "plugin pins" : "plugin directories"} have no Lando 4 target.`,
          remediation:
            "Install the Lando 4 equivalent of each plugin by hand; Lando 4 does not load plugins from the Landofile.",
        });
        break;
      case "keys":
        report([key], {
          kind: "dropped",
          message: "Lando 3 SSH key selection has no Lando 4 target.",
          remediation:
            "Lando 4 loads your default ~/.ssh keys through the SSH agent sidecar; for hardware-backed or 1Password keys, forward your host agent with sshAgent: { sidecar: false }.",
        });
        break;
      case "env_file":
        fragment[key] = value;
        break;
      case "volumes":
      case "networks":
        if (isPlainObject(value) && Object.keys(value).length > 0) {
          fragment[key] = Object.fromEntries(
            Object.entries(value).map(([name, config]) => [name, config ?? {}]),
          );
        }
        break;
      default:
        if (key.startsWith("x-")) fragment[key] = value;
    }
  }
  return { fragment, appMountExcludes, appMountIncludes, diagnostics };
};
