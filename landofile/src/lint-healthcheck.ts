import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import type { ConfigLintViolation } from "@lando/sdk/schema";
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
const COMPOSE_FIELDS = ["test", "interval", "timeout", "start_period", "start_interval"] as const;

export const healthcheckWarnings = (document: AuthoredDocument): readonly ConfigLintViolation[] => {
  const merged = document.value;
  const documents = document.provenance.documents;
  if (!isPlainRecord(merged.services)) return [];
  const origins = document.provenance.origins;
  const warnings: ConfigLintViolation[] = [];
  for (const [name, service] of Object.entries(merged.services)) {
    if (!isPlainRecord(service)) continue;
    for (const role of ["healthcheck", "readiness"] as const) {
      const healthcheck = service[role];
      const path = ["services", name, role];
      const sourceAt = (fieldPath: readonly string[]) => valueOriginAt(origins, fieldPath).source;
      if (Array.isArray(healthcheck) && ["CMD", "CMD-SHELL", "NONE"].includes(healthcheck[0])) {
        const source = sourceAt(path);
        warnings.push(
          attributeLintIssue(
            {
              rule: `${role}.bare-compose-marker`,
              severity: "warning",
              path,
              message: `A Compose test marker in bare ${role} argv is executed literally.`,
              suggestion: `Remove the marker for literal argv, or use a block ${role} object with test: and the Compose marker.`,
              source,
            },
            "effective",
            documents,
          ),
        );
      }
      if (!isPlainRecord(healthcheck)) continue;
      const lando = LANDO_FIELDS.filter((field) => Object.hasOwn(healthcheck, field));
      const compose = COMPOSE_FIELDS.filter((field) => Object.hasOwn(healthcheck, field));
      for (const field of lando) {
        const source = sourceAt([...path, field]);
        if (
          !compose.some((other) => {
            const origin = sourceAt([...path, other]);
            return origin.file !== source.file || origin.layer !== source.layer;
          })
        )
          continue;
        warnings.push(
          attributeLintIssue(
            {
              rule: `${role}.mixed-dialects`,
              severity: "warning",
              path,
              source,
              message: `Surviving ${role} fields combine Lando and Compose dialects from different sources.`,
              suggestion: `Use one ${role} dialect across layers. Lando fields take precedence over Compose fields.`,
            },
            "effective",
            documents,
          ),
        );
        break;
      }
    }
  }
  return warnings;
};
