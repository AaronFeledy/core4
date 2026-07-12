import type { AppPlan, ProviderCapabilities } from "@lando/sdk/schema";

export const HOST_PROXY_PLAN_EXTENSION_KEY = "@lando/core/host-proxy";

export interface HostProxyPlanExtension {
  readonly runLando: {
    readonly availability: "available" | "unavailable";
    readonly reason?: string;
  };
}

export const hostProxyUnavailableReason =
  "Provider hostReachability is none; host-proxy runLando is disabled.";

export const hostProxyNoTargetReason =
  "Provider declares no host-proxy Linux container target; host-proxy runLando is disabled.";

export const hostProxyPlanExtension = (plan: AppPlan): HostProxyPlanExtension | undefined => {
  const extension = plan.extensions[HOST_PROXY_PLAN_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null || Array.isArray(extension)) return undefined;
  const runLando = (extension as { readonly runLando?: unknown }).runLando;
  if (typeof runLando !== "object" || runLando === null || Array.isArray(runLando)) return undefined;
  const availability = (runLando as { readonly availability?: unknown }).availability;
  if (availability !== "available" && availability !== "unavailable") return undefined;
  const reason = (runLando as { readonly reason?: unknown }).reason;
  return {
    runLando: {
      availability,
      ...(typeof reason === "string" ? { reason } : {}),
    },
  };
};

export const hostProxyExtensionForCapabilities = (
  capabilities: ProviderCapabilities,
): HostProxyPlanExtension | undefined => {
  if (capabilities.hostReachability === "none") {
    return { runLando: { availability: "unavailable", reason: hostProxyUnavailableReason } };
  }
  if ((capabilities.hostProxy?.containerTargets.length ?? 0) === 0) {
    return { runLando: { availability: "unavailable", reason: hostProxyNoTargetReason } };
  }
  return undefined;
};
