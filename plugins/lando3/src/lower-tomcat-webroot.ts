import { posix } from "node:path";
import { isLegacyTagged } from "@lando/sdk/landofile";
import type { LoweringPatch, ServiceLoweringContext } from "./lowering-contract.ts";
import { needsReviewServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

export const lowerTomcatWebroot = (
  service: Readonly<Record<string, unknown>>,
  ctx: ServiceLoweringContext,
  appMountDisabled: boolean,
): LoweringPatch => {
  if (appMountDisabled) {
    return {
      patch: {},
      diagnostics: [
        needsReviewServiceKey({
          ctx,
          relative: ["webroot"],
          message: "Tomcat app_mount is disabled; no app-relative webroot was generated.",
          remediation: "Set an absolute webroot to the ROOT webapp directory the image provides.",
        }),
      ],
    };
  }

  const webroot = Object.hasOwn(service, "webroot") ? service.webroot : ".";
  if (isLegacyTagged(webroot))
    return {
      patch: {},
      diagnostics: [
        unsupportedServiceKey({
          ctx,
          relative: ["webroot"],
          message: "The legacy Tomcat webroot is a file reference and was not read.",
          remediation: "Set webroot to the literal ROOT webapp directory (<legacy root>/webapps/ROOT).",
        }),
      ],
    };
  if (typeof webroot !== "string") {
    return {
      patch: { webroot },
      diagnostics: [
        needsReviewServiceKey({
          ctx,
          relative: ["webroot"],
          message: "The legacy Tomcat webroot is not a literal path and was preserved unchanged.",
          remediation: "Set the Lando 4 webroot to the ROOT webapp directory (<legacy root>/webapps/ROOT).",
        }),
      ],
    };
  }

  const webapps = posix.join(webroot.replace(/^\/+/, ""), "webapps");
  return {
    patch: { webroot: posix.join(webapps, "ROOT") },
    diagnostics: [
      needsReviewServiceKey({
        ctx,
        relative: ["webroot"],
        message: `Lando 4 serves only the ROOT webapp at /; other webapps or WAR files under ${webapps} are not deployed.`,
        remediation:
          "Review the generated webroot and configure any other webapps or WAR deployments by hand.",
      }),
    ],
  };
};
