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
export const productionCapabilityProbe = (timeoutMs = 2000): CapabilityProbe => ({
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

/** In-flight production deliveries that must settle before process exit. */
const pendingNotifications = new Set<Promise<boolean>>();

/**
 * Sync seam for the event consumer. Accepts the notification for delivery and
 * tracks the async work so teardown can await completion. The boolean means
 * "accepted for delivery attempt", not "already delivered".
 */
export const productionTriggerNotificationSync = (message: string, title?: string): boolean => {
  const work = productionTriggerNotification(message, title);
  pendingNotifications.add(work);
  void work.finally(() => {
    pendingNotifications.delete(work);
  });
  return true;
};

/** Await every in-flight production notification delivery attempt. */
export const flushPendingNotifications = async (): Promise<void> => {
  while (pendingNotifications.size > 0) {
    await Promise.all([...pendingNotifications]);
  }
};
