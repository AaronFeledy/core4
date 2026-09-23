import type { ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { Lando3Path, MergedLegacyValue } from "./contract.ts";
import { occurrencesAt } from "./legacy-merge.ts";
import { makeReport } from "./lowering-report.ts";
import { hasTopLevelDisposition } from "./top-level-dispositions.ts";

type Finding = {
  readonly kind: "needs-review" | "unsupported";
  readonly message: string;
  readonly remediation: string;
};

const commandFindings = (text: string): readonly Finding[] => {
  const findings: Finding[] = [];
  // Delimit only the command token, never lando4, a filename, or a path to a binary.
  for (const match of text.matchAll(/(?:^|[\s;&|(`])lando[ \t]+([a-zA-Z][\w:-]*)(?=$|[\s;&|)`])/gu)) {
    const verb = match[1];
    const args = text.slice(match.index + match[0].length).split(/[\n;&|()`]/u)[0] ?? "";
    const has = (flags: string): boolean => new RegExp(`(?:^|\\s)(?:${flags})(?=$|[\\s=])`, "u").test(args);
    const review = (message: string, remediation: string): void => {
      findings.push({ kind: "needs-review", message, remediation });
    };
    switch (verb) {
      case "pull":
      case "push":
        findings.push({
          kind: "unsupported",
          message: `Legacy lando ${verb} hoster commands are not emulated by Lando 4.`,
          remediation:
            "Configure remote sources with lando4 remote:add and use lando4 pull/push for datasets, not hoster synchronization; otherwise keep this workflow on Lando 3.",
        });
        break;
      case "share":
        findings.push({
          kind: "unsupported",
          message: "Legacy lando share is not emulated by Lando 4.",
          remediation:
            "Configure a Lando 4 share provider before rewriting this workflow, or keep it on Lando 3.",
        });
        break;
      case "info":
        if (has("--filter|--deep|-d"))
          review(
            "Legacy lando info output flags differ: Lando 4 has no --filter; --deep is an agent-environment audit, not Docker inspect.",
            "Use lando4 info --service <svc> --format json and review consumers of the output.",
          );
        if (has("-s|--service"))
          review(
            "Legacy lando info scopes a service.",
            "Use lando4 info --service <svc> and review its structured output.",
          );
        break;
      case "rebuild":
        if (has("-s|--service"))
          review("Legacy lando rebuild scopes a service.", "Use lando4 rebuild --service <svc>.");
        break;
      case "logs":
        if (has("-t|--timestamps"))
          review(
            "Lando 4 logs has no timestamps flag.",
            "Use lando4 logs --service <svc> without -t/--timestamps.",
          );
        break;
      case "version":
        if (has("--all|-a|--component|-c"))
          review(
            "Lando 4 version reports core, Bun, and platform only, not component versions.",
            "Use lando4 version without --all/-a/--component/-c and review output consumers.",
          );
        break;
      case "list":
        review(
          "Lando 4 does not remove orphaned apps when listing apps.",
          "Use lando4 list; destroy orphaned apps explicitly.",
        );
        break;
    }
    review(
      "After conversion, lando still runs Lando 3.",
      "Call lando4 explicitly after reviewing command compatibility.",
    );
  }
  return findings;
};

const stringFindings = (text: string): readonly Finding[] => {
  const findings = [...commandFindings(text)];
  if (/\bLANDO_INFO\b/u.test(text))
    findings.push({
      kind: "needs-review",
      message: "Lando 4 does not set LANDO_INFO; no compatibility alias is added.",
      remediation: "Read the typed LANDO_DB_* / LANDO_SERVICE_* variables instead.",
    });
  if (/\bLANDO_MOUNT\b/u.test(text))
    findings.push({
      kind: "needs-review",
      message: "LANDO_MOUNT has no compatibility alias in Lando 4.",
      remediation: "Use LANDO_PROJECT_MOUNT instead.",
    });
  if (/\b(?:settings\.lando\.php|wp-config)\b/u.test(text))
    findings.push({
      kind: "needs-review",
      message:
        "settings.lando.php or wp-config may parse LANDO_INFO; conversion does not read or claim equivalence for that file.",
      remediation:
        "Review the referenced file and use typed LANDO_DB_* / LANDO_SERVICE_* variables; no compatibility alias is added.",
    });
  return findings;
};

export const legacyReferenceDiagnostics = (
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): readonly ConfigTranslateDiagnostic[] => {
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const report = makeReport(
    { fallbackSourceId: fallback, occurrenceAt: (path) => occurrencesAt(merged, path).at(-1) },
    diagnostics,
  );
  const visit = (value: MergedLegacyValue, path: Lando3Path): undefined => {
    switch (value.kind) {
      case "tagged":
        return;
      case "mapping":
        for (const [key, child] of value.entries) {
          if (path.length === 0 && (key === "name" || key === "recipe" || hasTopLevelDisposition(key)))
            continue;
          visit(child, [...path, key]);
        }
        return;
      case "sequence":
        value.items.forEach((item, index) => visit(item.value, [...path, index]));
        return;
      case "scalar": {
        if (typeof value.value !== "string") return;
        const findings = stringFindings(value.value);
        if (findings.length === 0) return;
        report(
          findings.some(({ kind }) => kind === "unsupported") ? "unsupported" : "needs-review",
          path,
          [...new Set(findings.map(({ message }) => message))].join(" "),
          [...new Set(findings.map(({ remediation }) => remediation))].join(" "),
        );
        return;
      }
      default:
        return value satisfies never;
    }
  };
  if (merged !== undefined) visit(merged, []);
  return diagnostics;
};
