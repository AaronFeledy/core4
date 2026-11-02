import { existsSync } from "node:fs";
import { type JourneyStepResult, bounded } from "./_acceptance-harness.ts";

export type LifecycleResult = JourneyStepResult<string>;
export type LifecycleAction = () => Promise<void>;
export type LifecycleActions = {
  readonly preflight: LifecycleAction;
  readonly install: LifecycleAction;
  readonly setup: LifecycleAction;
  readonly start: LifecycleAction;
  readonly functional: LifecycleAction;
  readonly destroy: LifecycleAction;
  readonly uninstall: LifecycleAction;
  readonly removal: LifecycleAction;
};

export class LifecycleJourneyError extends Error {
  override readonly name = "LifecycleJourneyError";
}

/** Cleanup is independent of the operational verdict, including partially failed start/setup. */
export const runLifecycle = async (actions: LifecycleActions) => {
  const steps: LifecycleResult[] = [];
  const attempt = async (id: keyof LifecycleActions): Promise<boolean> => {
    try {
      await actions[id]();
      steps.push({ id, exitCode: 0, stdout: "", stderr: "" });
      return true;
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      steps.push({ id, exitCode: 1, stdout: "", stderr: bounded(cause.message) });
      return false;
    }
  };
  let installed = false;
  let appAttempted = false;
  try {
    if (await attempt("preflight")) {
      // Installers may publish a binary before a later step fails.
      installed = true;
      if ((await attempt("install")) && (await attempt("setup"))) {
        appAttempted = true;
        if (await attempt("start")) await attempt("functional");
      }
    }
  } finally {
    if (appAttempted) await attempt("destroy");
    if (installed) {
      await attempt("uninstall");
      await attempt("removal");
    }
  }
  const passed = steps.length === 8 && steps.every((step) => step.exitCode === 0);
  return { steps, classification: { outcome: passed ? "passed" : "failed", exitCode: passed ? 0 : 1 } };
};

/** Windows uninstall schedules deletion after process exit; bound the wait and fail closed. */
export const assertLifecycleRemoval = async (paths: readonly string[], timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = paths.filter((path) => existsSync(path));
    if (remaining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new LifecycleJourneyError(`Uninstall left owned paths: ${remaining.join(", ")}`);
    }
    await Bun.sleep(100);
  }
};
