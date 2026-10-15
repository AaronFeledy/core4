import type { RendererIO } from "@lando/sdk/renderer";

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
