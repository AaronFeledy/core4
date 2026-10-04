import type { GlobalConfig } from "@lando/sdk/schema";

export interface TraceSelection {
  readonly enabled: boolean;
  readonly display: boolean;
  readonly endpoint?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const parseHeaders = (input: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const entry of input.split(",")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    try {
      const key = decodeURIComponent(entry.slice(0, separator).trim()).trim();
      const value = decodeURIComponent(entry.slice(separator + 1).trim()).trim();
      if (key !== "") headers[key] = value;
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      // Malformed optional exporter headers do not prevent command execution.
    }
  }
  return headers;
};

export const resolveTrace = (
  options: {
    readonly argv?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly config?: GlobalConfig["tracing"];
  } = {},
): TraceSelection & { readonly remainingArgv: ReadonlyArray<string> } => {
  const env = options.env ?? process.env;
  let display = env.LANDO_TRACE === "1" || env.LANDO_TRACE === "true";
  let afterTerminator = false;
  const remainingArgv: string[] = [];
  for (const arg of options.argv ?? []) {
    if (arg === "--") afterTerminator = true;
    if (!afterTerminator && arg === "--trace") display = true;
    else remainingArgv.push(arg);
  }
  const endpoint = options.config?.otlp?.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = options.config?.otlp?.headers ?? parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS ?? "");
  return {
    enabled: display || (endpoint !== undefined && endpoint !== ""),
    display,
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
    headers,
    env,
    remainingArgv,
  };
};

let active: TraceSelection | undefined;
export const setActiveTrace = (selection: TraceSelection | undefined): void => {
  active = selection;
};
export const activeTrace = (): TraceSelection | undefined => active;
