import { createPayloadRedactor } from "@lando/sdk/secrets";
import { Effect, Option } from "effect";
import { RedactionService, createPayloadValues, createStandaloneRedactor } from "./service.ts";

const LIMIT = 8 * 1024;
const CONTEXT_LIMIT = 8 * LIMIT;
const MARKER = "[diagnostic truncated]\n";
const encoder = new TextEncoder();

/** Resolve redaction once; each call creates independent bounded diagnostic state. Never feed stdout here. */
export const makeDiagnosticTailFactory = Effect.fnUntraced(function* (
  options: { readonly authoritativeTokens?: Iterable<string> | undefined } = {},
) {
  const service = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", options)
    : createStandaloneRedactor("secrets", options);
  const values = Option.isSome(service)
    ? yield* service.value.payloadValues(options)
    : createPayloadValues([], options);
  return () => {
    let suppressed = false;
    const tokenBuffer = new Uint8Array(LIMIT + 1);
    const tokenFits = (token: string) => {
      const encoded = encoder.encodeInto(token, tokenBuffer);
      return encoded.read === token.length && encoded.written <= LIMIT;
    };
    let previousValues: Iterable<string> | undefined;
    let filteredTokens: string[] = [];
    const payload = createPayloadRedactor(() => {
      const currentValues = values();
      if (currentValues === previousValues) return filteredTokens;
      previousValues = currentValues;
      const tokens = [...currentValues];
      // The exact matcher holds a partial token. Fail closed rather than hold an unbounded token.
      if (tokens.some((token) => !tokenFits(token))) suppressed = true;
      filteredTokens = tokens.filter((token) => tokenFits(token));
      return filteredTokens;
    });
    const decoder = new TextDecoder();
    let context = "";
    let contextBytes = 0;
    const collect = (text: string) => {
      if (suppressed) return;
      contextBytes += encoder.encode(text).length;
      if (contextBytes > CONTEXT_LIMIT) {
        // Canonical patterns can span arbitrary newlines. Never clip away their introducer.
        context = "";
        suppressed = true;
        return;
      }
      context += text;
    };
    let pending = "";
    let dropping = false;
    let truncated = false;
    let retained = "";
    let finished = false;
    const retain = (safe: string) => {
      const bytes = encoder.encode(retained + safe);
      if (bytes.length <= LIMIT - encoder.encode(MARKER).length) {
        retained += safe;
        return;
      }
      truncated = true;
      // Slice only already-redacted bytes and decode without a partial UTF-8 character.
      const tail = bytes.subarray(bytes.length - (LIMIT - encoder.encode(MARKER).length));
      let start = 0;
      while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start += 1;
      retained = new TextDecoder().decode(tail.subarray(start));
    };
    const consume = (text: string) => {
      for (const character of text) {
        if (character === "\n") {
          if (!dropping) retain(`${pending}\n`);
          pending = "";
          dropping = false;
        } else if (!dropping) {
          pending += character;
          if (encoder.encode(pending).length > LIMIT) {
            pending = "";
            dropping = true;
            truncated = true;
          }
        }
      }
    };
    return {
      write: (chunk: Uint8Array) => {
        if (finished) return;
        for (let offset = 0; offset < chunk.length && !suppressed; offset += LIMIT) {
          collect(decoder.decode(payload.write(chunk.subarray(offset, offset + LIMIT)), { stream: true }));
        }
      },
      finish: (): string | undefined => {
        if (!finished) {
          collect(decoder.decode(payload.flush(), { stream: true }) + decoder.decode());
          if (!suppressed) consume(redactor.redactString(context));
          context = "";
          if (!dropping && pending.length > 0) retain(pending);
          pending = "";
          finished = true;
        }
        if (suppressed) return MARKER.trimEnd();
        const result = `${truncated ? MARKER : ""}${retained}`;
        return result.length > 0 ? result : undefined;
      },
    };
  };
});

/** One bounded stderr collector per command subscription. Never feed stdout here. */
export const makeDiagnosticTail = Effect.fnUntraced(function* (
  options: { readonly authoritativeTokens?: Iterable<string> | undefined } = {},
) {
  const createTail = yield* makeDiagnosticTailFactory(options);
  return createTail();
});
