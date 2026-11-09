import { internalErrorRemediation } from "@lando/sdk/command-result";

export const runtimeRemediation =
  "Run `lando doctor` to check the container runtime, then retry the command.";

export type SocketHttpErrorKind = "connect" | "write" | "read" | "parse" | "http";
export type SocketReadSystemCode = "ECONNABORTED" | "ECONNRESET" | "EPIPE" | "ETIMEDOUT";

const remediationByKind = {
  connect: runtimeRemediation,
  write: runtimeRemediation,
  read: runtimeRemediation,
  http: runtimeRemediation,
  parse: internalErrorRemediation,
} satisfies Readonly<Record<SocketHttpErrorKind, string>>;

export class ContainerTransportError extends Error {
  readonly _tag = "ContainerTransportError";
  readonly kind: SocketHttpErrorKind;
  readonly operation: string;
  readonly remediation: string;
  readonly systemCode?: SocketReadSystemCode;
  readonly details?: unknown;

  constructor(input: {
    readonly kind: SocketHttpErrorKind;
    readonly operation: string;
    readonly message: string;
    readonly systemCode?: SocketReadSystemCode;
    readonly details?: unknown;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ContainerTransportError";
    this.kind = input.kind;
    this.operation = input.operation;
    this.remediation = remediationByKind[input.kind];
    if (input.systemCode !== undefined) this.systemCode = input.systemCode;
    if (input.details !== undefined) this.details = input.details;
  }
}
