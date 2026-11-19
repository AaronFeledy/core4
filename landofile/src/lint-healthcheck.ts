import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import type { ConfigLintViolation, ValidationIssue } from "@lando/sdk/schema";
import { attributeLintIssue } from "./lint-source.ts";
import type { AuthoredDocument } from "./provenance.ts";

const LANDO_FIELDS = [
  "kind",
  "command",
  "url",
  "port",
  "intervalSeconds",
  "timeoutSeconds",
  "startPeriodSeconds",
] as const;
const COMPOSE_REMEDIATION = {
  test: "Use `command:` without the `CMD` or `CMD-SHELL` marker, or `kind: none` for `NONE`. If a Lando command is already set, keep only the intended command.",
  interval:
    "Use `intervalSeconds:` with a number in seconds (for example, `interval: 1s` becomes `intervalSeconds: 1`).",
  timeout:
    "Use `timeoutSeconds:` with a number in seconds (for example, `timeout: 1s` becomes `timeoutSeconds: 1`).",
  start_period: "Use `startPeriodSeconds:` with a number in seconds.",
  start_interval: "Keep only `start_interval:` with the intended duration.",
  disable: "Use `kind: none` to disable the probe, or remove `disable:` to leave it enabled.",
} as const;
const COMPOSE_FIELDS = ["test", "interval", "timeout", "start_period", "start_interval", "disable"] as const;

function* probeFindings(
  document: AuthoredDocument,
  severity: ConfigLintViolation["severity"],
): Iterable<ValidationIssue & Pick<ConfigLintViolation, "rule" | "severity">> {
  const merged = document.value;
  if (!isPlainRecord(merged.services)) return;
  const origins = document.provenance.origins;
  for (const [name, service] of Object.entries(merged.services)) {
    if (!isPlainRecord(service)) continue;
    for (const role of ["healthcheck", "readiness"] as const) {
      const healthcheck = service[role];
      const path = ["services", name, role];
      const sourceAt = (fieldPath: readonly string[]) => valueOriginAt(origins, fieldPath).source;
      if (
        severity === "warning" &&
        Array.isArray(healthcheck) &&
        ["CMD", "CMD-SHELL", "NONE"].includes(healthcheck[0])
      ) {
        yield {
          rule: `${role}.bare-compose-marker`,
          severity: "warning",
          path,
          message: `A Compose test marker in bare ${role} argv is executed literally.`,
          suggestion: `Remove the marker for literal argv, or use a block ${role} object with test: and the Compose marker.`,
          source: sourceAt(path),
        };
      }
      if (!isPlainRecord(healthcheck)) continue;
      const lando = LANDO_FIELDS.filter((field) => Object.hasOwn(healthcheck, field));
      const compose = COMPOSE_FIELDS.filter((field) => Object.hasOwn(healthcheck, field));
      const rule = `${role}.mixed-dialects` as const;
      if (severity === "error") {
        for (const field of compose) {
          const fieldPath = [...path, field];
          const source = sourceAt(fieldPath);
          const candidates =
            field === "start_interval"
              ? Object.hasOwn(healthcheck, "startInterval")
                ? ["startInterval"]
                : []
              : lando;
          const conflict = candidates.find((key) => {
            const origin = sourceAt([...path, key]);
            return origin.file === source.file && origin.layer === source.layer;
          });
          if (conflict === undefined) continue;
          yield {
            rule,
            severity,
            path: fieldPath,
            source,
            message: `Compose \`${field}:\` and Lando \`${conflict}:\` cannot appear in the same ${role} source.`,
            suggestion: COMPOSE_REMEDIATION[field],
          };
        }
      } else {
        const candidates = Object.hasOwn(healthcheck, "startInterval") ? [...lando, "startInterval"] : lando;
        for (const field of candidates) {
          const source = sourceAt([...path, field]);
          if (
            !compose.some((other) => {
              if (field === "startInterval" && other !== "start_interval") return false;
              const origin = sourceAt([...path, other]);
              return origin.file !== source.file || origin.layer !== source.layer;
            })
          )
            continue;
          yield {
            rule,
            severity: "warning",
            path,
            source,
            message: `Surviving ${role} fields combine Lando and Compose dialects from different sources.`,
            suggestion: `Use one ${role} dialect across layers. Lando fields take precedence over Compose fields.`,
          };
          break;
        }
      }
    }
  }
}

export const healthcheckWarnings = (document: AuthoredDocument): readonly ConfigLintViolation[] =>
  Array.from(probeFindings(document, "warning"), (issue) =>
    attributeLintIssue(issue, "effective", document.provenance.documents),
  );

export const healthcheckDialectIssues = (document: AuthoredDocument): readonly ValidationIssue[] =>
  Array.from(probeFindings(document, "error"), ({ severity: _severity, ...issue }) => issue);
