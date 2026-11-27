import { sha256Hex } from "@lando/sdk/digest";
import { ScratchAppError } from "@lando/sdk/errors";
import { type AppPlan, type RoutePlan, isWildcardHostname } from "@lando/sdk/schema";
import type { ScratchAcquireInput } from "@lando/sdk/services";
import { Effect } from "effect";
import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";

const DNS_LABEL_LIMIT = 63;
const DNS_HOSTNAME_LIMIT = 253;

export const suffixScratchHostname = (
  hostname: string,
  scratchId: string,
  proxyDefaultDomain: string,
): string | undefined => {
  const labels = hostname.split(".");
  const lowerHost = hostname.toLowerCase();
  const domain = proxyDefaultDomain.toLowerCase();
  const domainLabels =
    lowerHost === domain || lowerHost.endsWith(`.${domain}`) ? domain.split(".").length : 2;
  const targetIndex = labels.length - domainLabels - 1;
  const target = labels[targetIndex];
  if (target === undefined) return undefined;
  const suffix = `--${scratchId}`;
  if (target === scratchId || target.endsWith(suffix)) return hostname;

  const available =
    Math.min(DNS_LABEL_LIMIT, DNS_HOSTNAME_LIMIT - hostname.length + target.length) - suffix.length;
  if (target.length <= available) {
    labels[targetIndex] = `${target}${suffix}`;
  } else {
    const digest = sha256Hex(target.toLowerCase()).slice(0, 8);
    if (available < digest.length) return undefined;
    const prefixLength = Math.min(12, available - digest.length - 1);
    const head = target.slice(0, Math.max(0, prefixLength)).replace(/-+$/u, "");
    const prefix = isWildcardHostname(target) && !isWildcardHostname(head) ? "*" : head;
    if (prefix.length > 0 && prefixLength < 1) return undefined;
    labels[targetIndex] = `${prefix.length === 0 ? digest : `${prefix}-${digest}`}${suffix}`;
  }
  return labels.join(".");
};

export const applyScratchHostnames = Effect.fnUntraced(function* (
  plan: AppPlan,
  input: Pick<ScratchAcquireInput, "noHostnameSuffix" | "hostnames">,
) {
  if (input.noHostnameSuffix === true || plan.routes.length === 0) return plan;
  const domain = yield* resolveProxyDefaultDomain;
  const preserved = new Set(input.hostnames);
  const sources = new Map<string, string>();
  const routes: RoutePlan[] = [];
  for (const route of plan.routes) {
    const original = route.hostname;
    const hostname = preserved.has(original) ? original : suffixScratchHostname(original, plan.id, domain);
    if (hostname === undefined)
      return yield* new ScratchAppError({
        operation: "plan",
        message: `Cannot suffix scratch route ${original} for service ${route.service} within DNS limits.`,
        remediation:
          "Choose a shorter route or domain, or explicitly preserve the hostname with `--hostname`.",
      });
    const previous = sources.get(hostname.toLowerCase());
    if (previous !== undefined && previous !== original.toLowerCase())
      return yield* new ScratchAppError({
        operation: "plan",
        message: `Scratch route ${original} for service ${route.service} and route ${previous} both rewrite to ${hostname}.`,
        remediation: "Choose different hostnames for these routes in the source Landofile.",
      });
    sources.set(hostname.toLowerCase(), original.toLowerCase());
    routes.push({ ...route, hostname });
  }
  return { ...plan, routes };
});
