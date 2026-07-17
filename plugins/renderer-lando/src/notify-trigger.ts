import type { CapabilityProbe } from "./capabilities.ts";

type OpenTuiLike = {
  createCliRenderer: (config: Record<string, unknown>) => Promise<{
    triggerNotification: (message: string, title?: string) => boolean;
    destroy: () => void;
  }>;
};

const isOpenTuiLike = (value: unknown): value is OpenTuiLike =>
  typeof value === "object" &&
  value !== null &&
  "createCliRenderer" in value &&
  typeof (value as OpenTuiLike).createCliRenderer === "function";

/**
 * Production probe: successful dynamic import of the substrate package promotes
 * color + notifications. Import failure / timeout leaves the initial snapshot.
 */
export const productionCapabilityProbe = (timeoutMs = 250): CapabilityProbe => ({
  timeoutMs,
  run: async () => {
    try {
      const mod: unknown = await import("@opentui/core");
      if (!isOpenTuiLike(mod)) return { kind: "no-response" };
      return { kind: "success", color: true, notifications: true };
    } catch {
      return { kind: "no-response" };
    }
  },
});

/**
 * One-shot OpenTUI triggerNotification path. Creates a short-lived renderer,
 * delivers the notification, and destroys it. Failures return false silently.
 */
export const productionTriggerNotification = async (message: string, title?: string): Promise<boolean> => {
  try {
    const mod: unknown = await import("@opentui/core");
    if (!isOpenTuiLike(mod)) return false;
    const renderer = await mod.createCliRenderer({
      exitOnCtrlC: false,
      useMouse: false,
      useKittyKeyboard: false,
    });
    try {
      return title === undefined
        ? renderer.triggerNotification(message)
        : renderer.triggerNotification(message, title);
    } finally {
      renderer.destroy();
    }
  } catch {
    return false;
  }
};

export const productionTriggerNotificationSync = (message: string, title?: string): boolean => {
  void productionTriggerNotification(message, title);
  return true;
};
