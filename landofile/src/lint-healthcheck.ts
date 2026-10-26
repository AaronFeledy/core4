import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import type { ConfigLintViolation } from "@lando/sdk/schema";
import { attributeLintIssue } from "./lint-source.ts";
import { getOrigins } from "./pipeline/origins.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";

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

export const healthcheckWarnings = (
  merged: Record<string, unknown>,
  documents: readonly SourceDocument[],
): readonly ConfigLintViolation[] => {
  if (!isPlainRecord(merged.services)) return [];
  const origins = getOrigins(merged);
  const warnings: ConfigLintViolation[] = [];
  for (const [name, service] of Object.entries(merged.services)) {
    if (!isPlainRecord(service)) continue;
    const healthcheck = service.healthcheck;
    const path = ["services", name, "healthcheck"];
    const sourceAt = (fieldPath: readonly string[]) =>
      origins === undefined ? undefined : valueOriginAt(origins, fieldPath).source;
    if (Array.isArray(healthcheck) && ["CMD", "CMD-SHELL", "NONE"].includes(healthcheck[0])) {
      const source = sourceAt(path);
      warnings.push(
        attributeLintIssue(
          {
            rule: "healthcheck.bare-compose-marker",
            severity: "warning",
            path,
            message: "A Compose test marker in bare healthcheck argv is executed literally.",
            suggestion:
              "Remove the marker for literal argv, or use a block healthcheck object with test: and the Compose marker.",
            ...(source === undefined ? {} : { source }),
          },
          "effective",
          documents,
        ),
      );
    }
    if (!isPlainRecord(healthcheck) || origins === undefined) continue;
    const lando = LANDO_FIELDS.filter((field) => Object.hasOwn(healthcheck, field));
    const compose = COMPOSE_FIELDS.filter((field) => Object.hasOwn(healthcheck, field));
    for (const field of lando) {
      const source = sourceAt([...path, field]);
      if (
        source === undefined ||
        !compose.some((other) => {
          const origin = sourceAt([...path, other]);
          return origin !== undefined && (origin.file !== source.file || origin.layer !== source.layer);
        })
      )
        continue;
      warnings.push(
        attributeLintIssue(
          {
            rule: "healthcheck.mixed-dialects",
            severity: "warning",
            path,
            source,
            message:
              "Surviving healthcheck fields combine Lando and Compose dialects from different sources.",
            suggestion:
              "Use one healthcheck dialect across layers. Lando fields take precedence over Compose fields.",
          },
          "effective",
          documents,
        ),
      );
      break;
    }
  }
  return warnings;
};
