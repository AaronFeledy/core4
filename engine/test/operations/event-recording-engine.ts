import { Effect } from "effect";

export const recordingEngine = (
  executed: string[],
  failure?: string,
  afterStep?: (name: string) => void,
) => ({
  id: "recording",
  run: (invocation: {
    readonly commands: ReadonlyArray<ReadonlyArray<string>>;
    readonly tool: string;
    readonly service?: string;
  }) =>
    Effect.sync(() => {
      const name = invocation.commands[0]?.[2]?.replace(/ "[$]@"$/u, "") ?? invocation.tool;
      executed.push(name);
      afterStep?.(name);
      return {
        tool: invocation.tool,
        service: invocation.service ?? ":lando",
        exitCode: failure !== undefined && name === `'${failure}'` ? 7 : 0,
        stdout: "",
        stderr: "",
      };
    }),
});
