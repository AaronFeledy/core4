type HostEnvironment = Readonly<Record<string, string | undefined>>;

export const isDumbTerminal = (env: HostEnvironment): boolean => env.TERM === "dumb";

export const hostDisablesColor = (env: HostEnvironment): boolean =>
  (env.NO_COLOR !== undefined && env.NO_COLOR !== "") || isDumbTerminal(env);
