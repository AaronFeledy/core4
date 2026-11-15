/** Runs full-tail steps one at a time: OpenTUI terminal transitions are asynchronous and reject overlap. */
export class TransitionQueue {
  #tail: Promise<void> | undefined;

  get idle(): boolean {
    return this.#tail === undefined;
  }

  /** Runs `step` now when idle, otherwise after the pending step settles. */
  run(step: () => Promise<void>): Promise<void> {
    const run = this.#tail === undefined ? step() : this.#tail.then(step);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tail = settled;
    void settled.then(() => {
      if (this.#tail === settled) this.#tail = undefined;
    });
    return run;
  }
}
