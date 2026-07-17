import type { LandoEvent } from "@lando/sdk/services";

import type { TaskTreeViewModel } from "./task-tree-tail.ts";

const SPINNER_THRESHOLD_MS = 100;
const SPINNER_FRAME_MS = 34;

interface TaskTreeAnimationOutput {
  readonly render: () => void;
  readonly requestLive: () => void;
  readonly dropLive: () => void;
}

const taskIdOf = (event: LandoEvent): string | undefined => {
  const taskId = Reflect.get(event, "taskId");
  return typeof taskId === "string" ? taskId : undefined;
};

export class TaskTreeAnimationController {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private liveActive = false;
  private visible = true;

  constructor(
    private readonly viewModel: TaskTreeViewModel,
    private readonly output: TaskTreeAnimationOutput,
  ) {}

  consume(event: LandoEvent): void {
    const taskId = taskIdOf(event);
    switch (event._tag) {
      case "task.start":
        if (taskId !== undefined) this.schedule(taskId);
        return;
      case "task.detail":
      case "task.complete":
      case "task.fail":
        if (taskId !== undefined) this.clear(taskId);
        return;
      case "task.tree.complete":
        this.clearAll();
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.clearAll();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible && this.frameTimer !== undefined) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    } else if (visible && this.viewModel.hasAnimatedAffordance()) {
      this.startFrames();
    }
    this.syncLive();
  }

  private schedule(taskId: string): void {
    this.clear(taskId);
    const timer = setTimeout(() => {
      this.pending.delete(taskId);
      if (!this.viewModel.isRunningTask(taskId)) return;
      this.viewModel.showSpinner(taskId);
      if (this.visible) this.output.render();
      this.syncLive();
      if (this.visible) this.startFrames();
    }, SPINNER_THRESHOLD_MS);
    this.pending.set(taskId, timer);
  }

  private clear(taskId: string): void {
    const pending = this.pending.get(taskId);
    if (pending !== undefined) clearTimeout(pending);
    this.pending.delete(taskId);
    const wasAnimated = this.viewModel.hasAnimatedAffordance();
    this.viewModel.hideSpinner(taskId);
    if (wasAnimated && this.visible) this.output.render();
    this.stopFramesWhenStatic();
    this.syncLive();
  }

  private clearAll(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const taskId of this.viewModel.focusableTaskIds()) this.viewModel.hideSpinner(taskId);
    this.stopFramesWhenStatic();
    this.syncLive();
  }

  private startFrames(): void {
    if (this.frameTimer !== undefined) return;
    this.frameTimer = setInterval(() => {
      this.viewModel.advanceSpinner();
      this.output.render();
    }, SPINNER_FRAME_MS);
  }

  private stopFramesWhenStatic(): void {
    if (this.viewModel.hasAnimatedAffordance() || this.frameTimer === undefined) return;
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
  }

  private syncLive(): void {
    const animated = this.visible && this.viewModel.hasAnimatedAffordance();
    if (animated && !this.liveActive) {
      this.output.requestLive();
      this.liveActive = true;
    } else if (!animated && this.liveActive) {
      this.output.dropLive();
      this.liveActive = false;
    }
  }
}
