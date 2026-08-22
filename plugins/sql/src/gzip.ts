import { basename } from "node:path";

export const isGzipPath = (path: string): boolean => basename(path).endsWith(".gz");

const quoteArg = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

const quoteCommand = (command: ReadonlyArray<string>): string => command.map(quoteArg).join(" ");

export const wrapImportCommand = (command: ReadonlyArray<string>, gzip: boolean): ReadonlyArray<string> =>
  gzip ? ["sh", "-c", `gunzip | ${quoteCommand(command)}`] : command;

export const wrapExportCommand = (command: ReadonlyArray<string>, gzip: boolean): ReadonlyArray<string> =>
  gzip ? ["sh", "-c", `${quoteCommand(command)} | gzip`] : command;
