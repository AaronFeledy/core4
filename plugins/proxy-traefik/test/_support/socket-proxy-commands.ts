export const socketProxyControlCommands = (command: readonly string[]): readonly (readonly string[])[] => {
  const [program, verb, ...args] = command;
  if (program === "systemctl" && (verb === "start" || verb === "stop")) return [[verb, ...args]];
  const script = command.find((argument) => argument.includes("systemctl "));
  if (script === undefined) return [];
  return script.split("\n").flatMap((line) => {
    if (!/^systemctl (start|stop) /u.test(line)) return [];
    return [line.replaceAll("'", "").split(/\s+/u).slice(1)];
  });
};
