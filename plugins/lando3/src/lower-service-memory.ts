import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { type LoweringPatch, type ServiceLoweringContext, isPlainObject } from "./lowering-contract.ts";
import { droppedServiceKey, rewrittenServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";
import { hasAuthoredEnvironment } from "./service-option-environment.ts";

export const lowerServiceMemory = (
  service: Record<string, unknown>,
  lowered: { readonly id: string; readonly patch: Readonly<Record<string, unknown>> },
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const { id } = lowered;
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const search = id === "elasticsearch" || id === "opensearch";
  for (const key of ["mem", "plugins"] as const) {
    if (!Object.hasOwn(service, key)) continue;
    const relative = [key];
    if (key === "plugins" && search) {
      blocked = true;
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative,
          message: `Lando 4 cannot install ${id} plugins.`,
          remediation:
            "Lando 4 has no catalog plugin installation; build a custom image that installs them and set image:, or keep the app on Lando 3.",
        }),
      );
    } else if (key === "mem" && id === "memcached") {
      const mem = service.mem;
      const valid =
        (typeof mem === "number" && Number.isFinite(mem)) || (typeof mem === "string" && /^\d+$/u.test(mem));
      if (valid && !Object.hasOwn(service, "command")) {
        patch.command = ["memcached", "-p", String(lowered.patch.port ?? 11211), "-m", String(mem)];
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative,
            message: "mem moved to the memcached command's -m option.",
            remediation: "Review the generated command.",
          }),
        );
      } else {
        diagnostics.push(
          droppedServiceKey({
            ctx,
            relative,
            message: valid
              ? "The authored command takes precedence over mem."
              : "mem requires a number or digit-string.",
            remediation: valid
              ? `Keep the authored command and add -m ${mem} to command.`
              : "Set a numeric memory size in MiB with -m in command.",
          }),
        );
      }
    } else if (key === "mem" && search) {
      const variable = id === "elasticsearch" ? "ES_JAVA_OPTS" : "OPENSEARCH_JAVA_OPTS";
      const environment = isPlainObject(lowered.patch.environment) ? lowered.patch.environment : {};
      const mem = service.mem;
      const valid = typeof mem === "string" && /^\d+[kmg]$/iu.test(mem);
      if (valid && !hasAuthoredEnvironment(service.environment, variable)) {
        patch.environment = { ...environment, [variable]: `-Xms${mem} -Xmx${mem}` };
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative,
            message: `mem moved to environment.${variable}.`,
            remediation: `Review the heap sizes in ${variable}.`,
          }),
        );
      } else {
        diagnostics.push(
          droppedServiceKey({
            ctx,
            relative,
            message: valid
              ? `The authored ${variable} takes precedence over mem.`
              : "Search heap memory requires an explicit unit.",
            remediation: valid
              ? `Set -Xms and -Xmx in the authored ${variable}.`
              : `Give a unit like 1024m and set -Xms1024m -Xmx1024m in environment.${variable}.`,
          }),
        );
      }
    } else {
      diagnostics.push(
        droppedServiceKey({
          ctx,
          relative,
          message: `${key} is not an option of ${id} in Lando 3 or Lando 4.`,
          remediation: `Remove ${key}.`,
        }),
      );
    }
  }
  return { patch, diagnostics, ...(blocked ? { blocked: true as const } : {}) };
};
