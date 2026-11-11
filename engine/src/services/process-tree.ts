import { isErrnoCode } from "@lando/sdk/errors";

const detachedChildren = new Set<number>();
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

export const registerDetachedProcess = (child: {
  readonly pid: number;
  readonly exited: Promise<number>;
}): void => {
  if (!exitListenerInstalled) {
    process.on("exit", () => {
      for (const pid of detachedChildren) killProcessTree(pid, "SIGKILL");
    });
    exitListenerInstalled = true;
  }
  detachedChildren.add(child.pid);
  void child.exited.then(() => detachedChildren.delete(child.pid));
};
