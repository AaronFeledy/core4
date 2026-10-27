import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import type { ConfigLintViolation } from "@lando/sdk/schema";
import { attributeLintIssue } from "./lint-source.ts";
import { getOrigins } from "./pipeline/origins.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";

const BIND_PATH = ["router", "bindAddress"] as const;

export const routerBindWarnings = (
  merged: Record<string, unknown>,
  documents: readonly SourceDocument[],
): readonly ConfigLintViolation[] => {
  if (!isPlainRecord(merged.router)) return [];
  if (typeof merged.router.bindAddress !== "string") return [];
  const origins = getOrigins(merged);
  const source = origins === undefined ? undefined : valueOriginAt(origins, BIND_PATH).source;
  return [
    attributeLintIssue(
      {
        rule: "router.bind-address-global-only",
        severity: "warning",
        path: [...BIND_PATH],
        message: "router.bindAddress is global-only and does not change the shared router bind.",
        suggestion:
          "Set router.bindAddress in the installation config.yml or LANDO_ROUTER_BIND_ADDRESS, then run lando start.",
        ...(source === undefined ? {} : { source }),
      },
      "effective",
      documents,
    ),
  ];
};
