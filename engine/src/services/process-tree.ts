import { isErrnoCode } from "@lando/sdk/errors";

type DetachedChild = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exited" | "exitCode" | "signalCode">;

const detachedChildren = new Set<DetachedChild>();
let exitListenerInstalled = false;

export const killProcessTree = (pid: number, signal: "SIGTERM" | "SIGKILL", detached = true): void => {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  try {
    process.kill(detached ? -pid : pid, signal);
  } catch (cause) {
    if (!isErrnoCode(cause, "ESRCH")) throw cause;
  }
};

export const registerDetachedProcess = (child: DetachedChild): void => {
  if (!exitListenerInstalled) {
    process.on("exit", () => {
      for (const child of detachedChildren)
        if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid, "SIGKILL");
    });
    exitListenerInstalled = true;
  }
  detachedChildren.add(child);
  void child.exited.then(() => detachedChildren.delete(child));
};
