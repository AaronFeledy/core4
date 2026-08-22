import { basename } from "node:path";

export const isGzipPath = (path: string): boolean => basename(path).endsWith(".gz");

const quoteArg = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

const quoteCommand = (command: ReadonlyArray<string>): string => command.map(quoteArg).join(" ");

const existingShellScript = (command: ReadonlyArray<string>): string | undefined =>
  command[0] === "sh" && command[1] === "-c" && typeof command[2] === "string" ? command[2] : undefined;

export const wrapImportCommand = (command: ReadonlyArray<string>, gzip: boolean): ReadonlyArray<string> => {
  if (!gzip) return command;
  const script = existingShellScript(command);
  return ["sh", "-c", `gunzip | ${script ?? quoteCommand(command)}`];
};

export const wrapExportCommand = (command: ReadonlyArray<string>, gzip: boolean): ReadonlyArray<string> => {
  if (!gzip) return command;
  const script = existingShellScript(command);
  return ["sh", "-c", `${script ?? quoteCommand(command)} | gzip`];
};
