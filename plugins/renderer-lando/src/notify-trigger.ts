import type { CapabilityProbe } from "./capabilities.ts";
import { loadOpenTuiModule } from "./opentui/prompt-driver.ts";

type OpenTuiNotifyModule = {
  createCliRenderer: (config: Record<string, unknown>) => Promise<{
    triggerNotification: (message: string, title?: string) => boolean;
    destroy: () => void;
  }>;
};

const isOpenTuiNotifyModule = (value: unknown): value is OpenTuiNotifyModule =>
  typeof value === "object" &&
  value !== null &&
  "createCliRenderer" in value &&
  typeof (value as OpenTuiNotifyModule).createCliRenderer === "function";

export const productionCapabilityProbe = (timeoutMs = 2000): CapabilityProbe => ({
  timeoutMs,
  run: async () => {
    try {
      const mod: unknown = await loadOpenTuiModule();
      if (!isOpenTuiNotifyModule(mod)) return { kind: "no-response" };
      return { kind: "success", color: true, notifications: true };
    } catch {
      return { kind: "no-response" };
    }
  },
});

export const productionTriggerNotification = async (message: string, title?: string): Promise<boolean> => {
  try {
    const mod: unknown = await loadOpenTuiModule();
    if (!isOpenTuiNotifyModule(mod)) return false;
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

const pendingNotifications = new Set<Promise<boolean>>();

export const productionTriggerNotificationSync = (message: string, title?: string): boolean => {
  const work = productionTriggerNotification(message, title);
  pendingNotifications.add(work);
  void work.finally(() => {
    pendingNotifications.delete(work);
  });
  return true;
};

export const flushPendingNotifications = async (): Promise<void> => {
  while (pendingNotifications.size > 0) {
    await Promise.all([...pendingNotifications]);
  }
};
