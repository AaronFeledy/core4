import { type Stats, fstatSync } from "node:fs";
import { isatty } from "node:tty";
import { Duration } from "effect";

import { McpTransportError } from "@lando/sdk/errors";

import type { ResultFormat } from "../cli/format-flags.ts";

export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_PARTIAL_BUFFER_BYTES = 1_048_576;
export const PARTIAL_FRAME_DEADLINE = Duration.seconds(5);
export const MAX_OUTSTANDING_REQUESTS = 256;
export const MAX_PENDING_CANCELLATIONS = 256;
export const MAX_OUTBOUND_QUEUED_MESSAGES = 1024;
export const MAX_OUTBOUND_QUEUED_BYTES = 8_388_608;
export const OUTBOUND_WRITE_DEADLINE = Duration.seconds(5);

export const stdioTransportError = (message: string, cause?: unknown): McpTransportError =>
  new McpTransportError({
    message,
    remediation: "Restart the MCP client with healthy piped stdin/stdout and retry the request.",
    ...(cause === undefined ? {} : { cause }),
  });

export interface McpStdioEndpointCapability {
  readonly available: boolean;
  readonly tty: boolean;
  readonly kind: "file" | "fifo" | "socket" | "character" | "other";
}

export interface McpServeStartupInput {
  readonly resultFormat: ResultFormat;
  readonly stdin: McpStdioEndpointCapability;
  readonly stdout: McpStdioEndpointCapability;
}

export const classifyMcpServeStartup = (input: McpServeStartupInput): McpTransportError | undefined => {
  if (input.resultFormat !== "text") {
    return new McpTransportError({
      message: "MCP serve mode cannot use command-result machine output.",
      remediation: "Remove --format, or add --list to inspect the MCP catalog as machine output.",
    });
  }
  const supported = [input.stdin, input.stdout].every(
    (endpoint) =>
      endpoint.available &&
      !endpoint.tty &&
      (endpoint.kind === "file" || endpoint.kind === "fifo" || endpoint.kind === "socket"),
  );
  return supported
    ? undefined
    : new McpTransportError({
        message: "MCP serve mode requires usable non-TTY stdin and stdout descriptors.",
        remediation: "Launch `lando mcp` from an MCP client with stdin and stdout connected as pipes.",
      });
};

const endpointKind = (stats: Stats): McpStdioEndpointCapability["kind"] => {
  if (stats.isFile()) return "file";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character";
  return "other";
};

const inspectMcpStdioEndpoint = (fd: number): McpStdioEndpointCapability => {
  try {
    const stats = fstatSync(fd);
    return { available: true, tty: isatty(fd), kind: endpointKind(stats) };
  } catch {
    return { available: false, tty: false, kind: "other" };
  }
};

export const mcpServeStartupError = (resultFormat: ResultFormat): McpTransportError | undefined =>
  resultFormat !== "text"
    ? classifyMcpServeStartup({
        resultFormat,
        stdin: { available: false, tty: false, kind: "other" },
        stdout: { available: false, tty: false, kind: "other" },
      })
    : classifyMcpServeStartup({
        resultFormat,
        stdin: inspectMcpStdioEndpoint(0),
        stdout: inspectMcpStdioEndpoint(1),
      });
