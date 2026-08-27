import type { RendererIO } from "@lando/sdk/renderer";

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

const BEL = "\u0007";
const OSC = "\u001b]";

const osc99 = (part: "title" | "body", payload: string, done: 0 | 1): string =>
  `${OSC}99;i=lando:d=${String(done)}:p=${part};${payload}${BEL}`;

export const encodeDesktopNotification = (message: string, title?: string): string => {
  if (title === undefined) return osc99("body", message, 0);
  return `${osc99("title", title, 0)}${osc99("body", message, 1)}`;
};

export const writeDesktopNotification = (io: RendererIO, text: string): void => {
  const stream = io.externalOutputStream;
  if (stream !== undefined) {
    stream.write(text);
    return;
  }
  io.writeStdout(text);
};

const pendingNotifications = new Set<Promise<boolean>>();

export const bindDesktopNotificationTrigger = (write: (text: string) => void) => {
  const trigger = (message: string, title?: string): boolean => {
    const work = Promise.resolve()
      .then(() => {
        write(encodeDesktopNotification(message, title));
        return true;
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error) return false;
        return false;
      });
    pendingNotifications.add(work);
    void work.finally(() => {
      pendingNotifications.delete(work);
    });
    return true;
  };
  return trigger;
};

export const bindIoDesktopNotificationTrigger = (io: RendererIO) =>
  bindDesktopNotificationTrigger((text) => writeDesktopNotification(io, text));

export const flushPendingNotifications = async (): Promise<void> => {
  while (pendingNotifications.size > 0) {
    await Promise.all([...pendingNotifications]);
  }
};
