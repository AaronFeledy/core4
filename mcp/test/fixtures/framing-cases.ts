import type { Schema } from "effect";

type Fault = { readonly _tag: "McpTransportError"; readonly message: string; readonly remediation: string };
type Write = { readonly bytes: () => Uint8Array; readonly advanceBeforeMs?: number };

export interface FramingCase {
  readonly id: string;
  readonly writes: readonly Write[];
  readonly replies: readonly Schema.JsonObject[];
  readonly closeInput: "before-replies" | "after-replies" | "never";
  readonly exit: "clean" | Fault;
  readonly usabilityPing?: true;
  readonly virtualTime?: true;
  readonly pipe?: "source" | "both";
}

const encoder = new TextEncoder();
const write = (text: string): Write => ({ bytes: () => encoder.encode(text) });
export const ping = (id: number): Schema.JsonObject => ({ jsonrpc: "2.0", id, method: "ping" });
export const pong = (id: number): Schema.JsonObject => ({ jsonrpc: "2.0", id, result: {} });
const pingLine = (id: number) => `${JSON.stringify(ping(id))}\n`;
const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
const malformed = '{"jsonrpc":"2.0","id":12,"method":"tools/list",}\n';

const oversize: Fault = {
  _tag: "McpTransportError",
  message: "MCP stdio frame exceeded the 1 MiB inbound limit.",
  remediation:
    "Reconnect and send each JSON-RPC message as one line of at most 1 MiB, including any CR before LF.",
};
const partial: Fault = {
  _tag: "McpTransportError",
  message: "MCP stdio closed with an incomplete non-whitespace frame.",
  remediation: "End every JSON-RPC message with LF before closing stdin.",
};
const deadline: Fault = {
  _tag: "McpTransportError",
  message: "MCP stdio partial frame exceeded the 5 second deadline.",
  remediation:
    "Reconnect and write each JSON-RPC message with its terminating LF in one flush, within 5 seconds of its first byte.",
};

const blank = (id: string, bytes: string, pipe?: "source"): FramingCase => ({
  id,
  writes: [write(bytes + pingLine(30))],
  replies: [pong(30)],
  exit: "clean",
  closeInput: "after-replies",
  ...(pipe ? { pipe } : {}),
});

const recover = (id: string, chunks: readonly string[], errors: number, pipe?: "both"): FramingCase => ({
  id,
  writes: chunks.map(write),
  replies: [pong(19), pong(20), ...Array.from({ length: errors }, () => parseError)],
  exit: "clean",
  closeInput: "after-replies",
  usabilityPing: true,
  ...(pipe ? { pipe } : {}),
});

const cap = (ending: "lf" | "crlf", overflow: 0 | 1): FramingCase => {
  const head = '{"jsonrpc":"2.0","id":40,"method":"ping","params":{"padding":"';
  const tail = ending === "crlf" ? '"}}\r' : '"}}';
  return {
    id: `cap-${ending}-${overflow === 0 ? "exact" : "over"}`,
    writes: [
      { bytes: () => encoder.encode(`${head}é`).subarray(0, head.length + 1) },
      {
        bytes: () =>
          encoder
            .encode(`é${"x".repeat(1_048_576 + overflow - head.length - 2 - tail.length)}${tail}\n`)
            .subarray(1),
      },
    ],
    replies: overflow === 0 ? [pong(40)] : [],
    exit: overflow === 0 ? "clean" : oversize,
    closeInput: overflow === 0 ? "after-replies" : "never",
    ...(ending === "crlf" ? { pipe: "both" } : {}),
  };
};

export const FRAMING_CASES: readonly FramingCase[] = [
  blank("blank-space", " \n"),
  blank("blank-tab", "\t\n"),
  blank("blank-cr", "\r\n"),
  blank("blank-mixed", "  \t \r\n", "source"),
  blank("blank-empty", "\n"),
  {
    id: "crlf-request",
    writes: [write(pingLine(30).replace("\n", "\r\n"))],
    replies: [pong(30)],
    exit: "clean",
    closeInput: "after-replies",
    pipe: "source",
  },
  recover("malformed-one-chunk", [pingLine(19) + malformed + pingLine(20)], 1, "both"),
  recover("malformed-separate-writes", [pingLine(19), malformed, pingLine(20)], 1),
  recover("malformed-two-mixed", [`${pingLine(19)}${malformed}\f\n${pingLine(20)}`], 2),
  {
    id: "oversize-content",
    writes: [
      {
        bytes: () =>
          encoder.encode(
            `{"jsonrpc":"2.0","id":10,"method":"ping","params":{"padding":"${"x".repeat(1_048_576)}"}}\n`,
          ),
      },
    ],
    replies: [],
    exit: oversize,
    closeInput: "never",
  },
  ...[false, true].map(
    (lf): FramingCase => ({
      id: lf ? "oversize-blank-lf" : "oversize-blank",
      writes: [{ bytes: () => encoder.encode(" ".repeat(1_048_577) + (lf ? "\n" : "")) }],
      replies: [],
      exit: oversize,
      closeInput: "never",
      ...(lf ? { pipe: "source" } : {}),
    }),
  ),
  cap("lf", 0),
  cap("lf", 1),
  cap("crlf", 0),
  cap("crlf", 1),
  ...["json", "drip", "space"].map(
    (kind): FramingCase => ({
      id: `deadline-${kind}`,
      writes: [
        write(kind === "space" ? " " : '{"jsonrpc":"2.0"'),
        ...(kind === "drip" ? [{ ...write(',"id":15'), advanceBeforeMs: 4_000 }] : []),
      ],
      replies: [],
      exit: deadline,
      closeInput: "never",
      virtualTime: true,
    }),
  ),
  {
    id: "eof-mid-frame-json",
    writes: [write('{"jsonrpc":"2.0","id":11,"method":"ping"}')],
    replies: [],
    exit: partial,
    closeInput: "before-replies",
    pipe: "both",
  },
  {
    id: "eof-mid-frame-formfeed",
    writes: [write("\f")],
    replies: [],
    exit: partial,
    closeInput: "before-replies",
  },
  {
    id: "eof-clean-blank-partial",
    writes: [write("  \n\t")],
    replies: [],
    exit: "clean",
    closeInput: "before-replies",
    pipe: "source",
  },
  { id: "eof-clean", writes: [], replies: [], exit: "clean", closeInput: "before-replies" },
];

export const expectedReplies = (row: FramingCase) =>
  row.usabilityPing ? [...row.replies, pong(21)] : row.replies;

export const containsReplies = (
  observed: readonly Schema.JsonObject[],
  wanted: readonly Schema.JsonObject[],
) =>
  wanted.every(
    (reply) =>
      observed.filter((frame) => Bun.deepEquals(frame, reply)).length >=
      wanted.filter((frame) => Bun.deepEquals(frame, reply)).length,
  );
