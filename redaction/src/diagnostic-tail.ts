import { createPayloadRedactor, isSecretEnvName } from "@lando/sdk/secrets";
import { Effect, Option } from "effect";
import { RedactionService, createPayloadValues, createStandaloneRedactor } from "./service.ts";

const LIMIT = 8 * 1024;
const MARKER = "[diagnostic truncated]\n";
const encoder = new TextEncoder();
const COMMAND_SECRET_ENV = new Set(["PGPASSWORD", "MYSQL_PWD", "SQLCMDPASSWORD", "MONGO_URI"]);

/** One bounded stderr collector per command subscription. Never feed stdout here. */
export const makeDiagnosticTail = Effect.fnUntraced(function* (env?: Readonly<Record<string, string>>) {
  const authoritativeTokens = Object.entries(env ?? {})
    .filter(([key, value]) => (isSecretEnvName(key) || COMMAND_SECRET_ENV.has(key)) && value.length > 0)
    .map(([, value]) => value);
  if (env?.MONGO_URI !== undefined) {
    try {
      const password = decodeURIComponent(new URL(env.MONGO_URI).password);
      if (password.length > 0) authoritativeTokens.push(password);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof URIError)) throw error;
    }
  }
  const options = { authoritativeTokens };
  const service = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", options)
    : createStandaloneRedactor("secrets", options);
  const values = Option.isSome(service)
    ? yield* service.value.payloadValues(options)
    : createPayloadValues([], options);
  let suppressed = false;
  const payload = createPayloadRedactor(() => {
    const tokens = [...values()];
    // The exact matcher holds a partial token. Fail closed rather than hold an unbounded token.
    if (tokens.some((token) => encoder.encode(token).length > LIMIT)) suppressed = true;
    return tokens.filter((token) => encoder.encode(token).length <= LIMIT);
  });
  const decoder = new TextDecoder();
  let pending = "";
  let dropping = false;
  let truncated = false;
  let retained = "";
  let finished = false;
  const retain = (line: string) => {
    const safe = redactor.redactString(line);
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
      if (!finished) consume(decoder.decode(payload.write(chunk), { stream: true }));
    },
    finish: (): string | undefined => {
      if (!finished) {
        consume(decoder.decode(payload.flush(), { stream: true }) + decoder.decode());
        if (!dropping && pending.length > 0) retain(pending);
        pending = "";
        finished = true;
      }
      if (suppressed) return MARKER.trimEnd();
      const result = `${truncated ? MARKER : ""}${retained}`;
      return result.length > 0 ? result : undefined;
    },
  };
});
