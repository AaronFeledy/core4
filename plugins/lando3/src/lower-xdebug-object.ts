import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { type LoweringPatch, type ServiceLoweringContext, isPlainObject } from "./lowering-contract.ts";
import { droppedServiceKey, rewrittenServiceKey } from "./service-diagnostics.ts";
import { hasAuthoredEnvironment } from "./service-option-environment.ts";

// Match service-lando's PHP_XDEBUG_CLIENT_HOST / PHP_XDEBUG_PORT without a cross-plugin dependency.
const CLIENT_HOST = "host.docker.internal";
const CLIENT_PORT = 9003;

export const lowerXdebugObject = (
  service: Record<string, unknown>,
  xdebug: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const patch: Record<string, unknown> = {
    xdebug: typeof xdebug.mode === "string" && xdebug.mode.trim().length > 0 ? xdebug.mode : true,
  };
  const diagnostics: ConfigTranslateDiagnostic[] = [
    rewrittenServiceKey({
      ctx,
      relative: ["xdebug"],
      message: "The Xdebug object became a mode string or true.",
      remediation: "Review the Xdebug mode in the generated service.",
    }),
  ];
  const settings = new Map<string, string>();
  const authored = hasAuthoredEnvironment(service.environment, "XDEBUG_CONFIG");
  for (const [key, value] of Object.entries(xdebug)) {
    if (key === "mode") continue;
    if (key === "start_with_request" || key === "client_port") {
      const valid =
        key === "start_with_request"
          ? typeof value === "boolean" || typeof value === "string"
          : (typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "string" && /^\d+$/u.test(value));
      if (valid && !authored) {
        settings.set(key, typeof value === "boolean" ? (value ? "yes" : "no") : String(value));
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["xdebug", key],
            message: `${key} moved to environment.XDEBUG_CONFIG.`,
            remediation: "Review the generated XDEBUG_CONFIG environment variable.",
          }),
        );
      } else {
        diagnostics.push(
          droppedServiceKey({
            ctx,
            relative: ["xdebug", key],
            message: authored
              ? "The authored XDEBUG_CONFIG takes precedence."
              : `${key} has an invalid value.`,
            remediation: `Add a valid ${key} setting to the service's environment.XDEBUG_CONFIG.`,
          }),
        );
      }
      continue;
    }
    if (key === "config" && isPlainObject(value)) {
      for (const iniKey of Object.keys(value)) {
        diagnostics.push(
          droppedServiceKey({
            ctx,
            relative: ["xdebug", "config", iniKey],
            message: `Xdebug ini setting ${iniKey} has no inline target.`,
            remediation: `Set xdebug.${iniKey} in a PHP ini file mounted through the service config or mounts.`,
          }),
        );
      }
    } else {
      diagnostics.push(
        droppedServiceKey({
          ctx,
          relative: ["xdebug", key],
          message: `${key} has no Lando 4 Xdebug object target.`,
          remediation:
            "Set the required xdebug settings in a PHP ini file mounted through the service config or mounts.",
        }),
      );
    }
  }
  if (settings.size > 0) {
    const start = settings.get("start_with_request");
    patch.environment = {
      XDEBUG_CONFIG: `client_host=${CLIENT_HOST} client_port=${settings.get("client_port") ?? CLIENT_PORT}${start === undefined ? "" : ` start_with_request=${start}`}`,
    };
  }
  return { patch, diagnostics };
};
