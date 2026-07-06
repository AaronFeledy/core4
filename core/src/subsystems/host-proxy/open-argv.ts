import { LandoCommandError } from "@lando/sdk/errors";

import type { OpenAppOptions } from "../../cli/commands/open.ts";

const OPEN_COMMAND = "app:open" as const;

export type OpenArgvParseResult =
  | { readonly _tag: "success"; readonly options: OpenAppOptions }
  | { readonly _tag: "failure"; readonly error: LandoCommandError };

const invalidOpenArgv = (message: string): OpenArgvParseResult => ({
  _tag: "failure",
  error: new LandoCommandError({ message, commandId: OPEN_COMMAND, exitCode: 1 }),
});

const flagValue = (token: string, flag: string): string | undefined =>
  token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : undefined;

export const parseOpenOptionsFromRunLandoArgv = (
  argv: ReadonlyArray<string>,
  context: { readonly tty: boolean },
): OpenArgvParseResult => {
  const tokens = argv.slice(1);
  let service: string | undefined;
  let route: string | undefined;
  let all = false;
  let print = false;
  let json = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token.length === 0) return invalidOpenArgv("Missing app:open argument.");
    const serviceValue = flagValue(token, "--service") ?? flagValue(token, "-s");
    const routeValue = flagValue(token, "--route");
    const formatValue = flagValue(token, "--format");
    if (serviceValue !== undefined) {
      if (serviceValue.length === 0) return invalidOpenArgv("Missing value for --service.");
      service = serviceValue;
    } else if (routeValue !== undefined) {
      if (routeValue.length === 0) return invalidOpenArgv("Missing value for --route.");
      route = routeValue;
    } else if (formatValue !== undefined) {
      json = formatValue === "json";
    } else if (token === "--service" || token === "-s") {
      index += 1;
      const value = tokens[index];
      if (value === undefined || value.startsWith("-"))
        return invalidOpenArgv("Missing value for --service.");
      service = value;
    } else if (token === "--route") {
      index += 1;
      const value = tokens[index];
      if (value === undefined || value.startsWith("-")) return invalidOpenArgv("Missing value for --route.");
      route = value;
    } else if (token === "--all") all = true;
    else if (token === "--print") print = true;
    else if (token === "--json") json = true;
    else if (token === "--format") {
      index += 1;
      const value = tokens[index];
      if (value === undefined || value.startsWith("-")) return invalidOpenArgv("Missing value for --format.");
      json = value === "json";
    } else return invalidOpenArgv(`Unsupported app:open argument: ${token}.`);
    index += 1;
  }
  return {
    _tag: "success",
    options: {
      ...(service === undefined ? {} : { service }),
      ...(route === undefined ? {} : { route }),
      ...(all ? { all } : {}),
      ...(print ? { print } : {}),
      json,
      ttyPresent: context.tty,
    },
  };
};

export const openOptionsFromRunLandoArgv = (
  argv: ReadonlyArray<string>,
  context: { readonly tty: boolean },
): OpenAppOptions => {
  const parsed = parseOpenOptionsFromRunLandoArgv(argv, context);
  if (parsed._tag === "failure") throw parsed.error;
  return parsed.options;
};
