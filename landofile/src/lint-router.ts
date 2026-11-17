import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import type { ConfigLintViolation } from "@lando/sdk/schema";
import { attributeLintIssue } from "./lint-source.ts";
import type { AuthoredDocument } from "./provenance.ts";

const BIND_PATH = ["router", "bindAddress"] as const;

export const routerBindWarnings = (document: AuthoredDocument): readonly ConfigLintViolation[] => {
  const merged = document.value;
  if (!isPlainRecord(merged.router)) return [];
  if (typeof merged.router.bindAddress !== "string") return [];
  const source = valueOriginAt(document.provenance.origins, BIND_PATH).source;
  return [
    attributeLintIssue(
      {
        rule: "router.bind-address-global-only",
        severity: "warning",
        path: [...BIND_PATH],
        message: "router.bindAddress is global-only and does not change the shared router bind.",
        suggestion:
          "Set router.bindAddress in the installation config.yml or LANDO_ROUTER_BIND_ADDRESS, then run lando start.",
        source,
      },
      "effective",
      document.provenance.documents,
    ),
  ];
};
