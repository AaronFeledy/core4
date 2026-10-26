import { REDACTED } from "@lando/sdk/secrets";

const diagnosticLimit = 8 * 1024;
const contextLimit = 64 * 1024;
const diagnosticMarker = "\n[diagnostic truncated]";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const redactCompletionString = (value: string, redact: (value: unknown) => unknown): string => {
  const redacted = redact(value);
  return typeof redacted === "string" ? redacted : REDACTED;
};

export const boundedDiagnostic = (
  stderr: string,
  redact: (value: unknown) => unknown,
): string | undefined => {
  if (stderr.length === 0) return undefined;
  const safe = redactCompletionString(stderr, redact);
  const buffer = new Uint8Array(diagnosticLimit);
  const encoded = encoder.encodeInto(safe, buffer);
  if (encoded.read === safe.length) return decoder.decode(buffer.subarray(0, encoded.written));
  // encodeInto writes only complete UTF-8 codepoints; clipping happens after full-context redaction.
  const clipped = encoder.encodeInto(safe, buffer.subarray(0, diagnosticLimit - diagnosticMarker.length));
  return `${decoder.decode(buffer.subarray(0, clipped.written))}${diagnosticMarker}`;
};

export const makeCompletionDiagnosticContext = () => {
  let context: Uint8Array | undefined = new Uint8Array(contextLimit);
  let length = 0;
  return {
    write: (chunk: Uint8Array): void => {
      if (context === undefined) return;
      if (chunk.byteLength > contextLimit - length) {
        // A partial credential or PEM cannot be safely redacted. Drop all context permanently.
        context = undefined;
        return;
      }
      context.set(chunk, length);
      length += chunk.byteLength;
    },
    text: (): string =>
      context === undefined ? diagnosticMarker.trimStart() : decoder.decode(context.subarray(0, length)),
  };
};
