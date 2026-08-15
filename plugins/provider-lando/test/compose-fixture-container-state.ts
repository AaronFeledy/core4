export class ComposeFixtureContainerStateError extends Error {
  override readonly name = "ComposeFixtureContainerStateError";

  constructor(
    readonly containerName: string,
    readonly observedState: unknown,
  ) {
    super(
      `Service container ${containerName} is not running; observed State: ${JSON.stringify(observedState)}`,
    );
  }
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

export const assertServiceContainerRunning = (inspect: unknown, containerName: string): void => {
  const state = field(inspect, "State");
  if (field(state, "Running") === true && field(state, "Status") === "running") return;

  throw new ComposeFixtureContainerStateError(containerName, state);
};
