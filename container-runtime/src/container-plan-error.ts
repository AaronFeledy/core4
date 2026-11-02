export class ContainerPlanError extends Error {
  readonly _tag = "ContainerPlanError";
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ContainerPlanError";
    if (details !== undefined) this.details = details;
  }
}
