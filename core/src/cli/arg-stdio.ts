export const argStdioDescription = (arg: {
  readonly description?: string;
  readonly stdio?: "stdin" | "stdout";
}): string | undefined => {
  if (arg.stdio === undefined) return arg.description;
  const sentence = {
    stdin: "Use - to read from stdin.",
    stdout: "Use - to write to stdout.",
  }[arg.stdio];
  return arg.description ? `${arg.description} ${sentence}` : sentence;
};
