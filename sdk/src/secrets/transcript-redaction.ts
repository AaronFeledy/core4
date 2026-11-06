import {
  TRANSCRIPT_KEY_STOP_CLASS,
  TRANSCRIPT_SHORT_STOP_CLASS,
  keepCompleteEnvPlaceholderOrRedact,
  unquotedSecretValueSource,
} from "./env-placeholder.ts";
import { REDACTED } from "./redactor.ts";
import { SECRET_WORD_SOURCE } from "./secret-names.ts";

export interface TranscriptRedactionEnv {
  readonly home?: string;
  readonly tmp?: string;
  readonly user?: string;
  readonly host?: string;
  readonly extraRoots?: readonly string[];
}

const HOME = "<HOME>";
const TMP = "<TMP>";
const USER = "<USER>";
const HOST = "<HOST>";
const PORT = "<PORT>";
const CONTAINER_ID = "<CONTAINER_ID>";
const PROVIDER_ID = "<PROVIDER_ID>";
const DIGEST = "<DIGEST>";
const WELL_KNOWN_PORTS = new Set([80, 443, 3000, 3306, 5432, 8080, 8443, 9000, 9229]);
const BT = "`";

const FIXTURE_PATH = /(^|[\s"'`(=])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9._-]+[\\/])*fixtures[\\/][^\s"'`)]+)/giu;

// Escaped and plain quotes, then unquoted values that prefer complete `${IDENT}`.
const QUOTED_VALUE_SOURCE = `${String.raw`\\"[^"]*\\"|\\'[^']*\\'|`}\\\\${BT}[^${BT}]*\\\\${BT}|${String.raw`"[^"]*"|'[^']*'|`}${BT}[^${BT}]*${BT}`;
const SHORT_VALUE_SOURCE = `${QUOTED_VALUE_SOURCE}|${unquotedSecretValueSource(TRANSCRIPT_SHORT_STOP_CLASS)}`;
const SHORT_EQUALS_SECRET = new RegExp(`(^|[\\s"'${BT}(])(-[tk])\\s*=\\s*(${SHORT_VALUE_SOURCE})`, "giu");
const SHORT_SPACE_SECRET = new RegExp(`(^|[\\s"'${BT}(])(-[tk])\\s+(${SHORT_VALUE_SOURCE})`, "giu");

const KEY_VALUE_SOURCE = `${QUOTED_VALUE_SOURCE}|${unquotedSecretValueSource(TRANSCRIPT_KEY_STOP_CLASS)}`;
const KEY_EQUALS_SECRET = new RegExp(
  `(?<![?&A-Za-z0-9_.-])([A-Za-z0-9_.-]*(?:${SECRET_WORD_SOURCE})[A-Za-z0-9_.-]*)\\s*=\\s*(${KEY_VALUE_SOURCE})`,
  "giu",
);
const KEY_SPACE_SECRET = new RegExp(`\\b(${SECRET_WORD_SOURCE})\\s+(${KEY_VALUE_SOURCE})`, "giu");
const TOKEN_SECRET_LITERAL = /\btoken\s+secret\b/gi;
const GENERIC_PATHS: readonly RegExp[] = [
  /\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?/gi,
  /\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/gi,
  /\/root(?:\/[^\s"'`]*)?/gi,
  /\/var\/folders\/[^/]+\/T(?:\/[^\s"'`]*)?/gi,
  /\/tmp\/(?:lando-)?[^/\s"'`]+(?:\/[^\s"'`]*)?/gi,
  /[A-Za-z]:\\(?:Users|AppData\\Local\\Temp)[^"\s'`]*/gi,
  /%USERPROFILE%[^"\s'`]*/gi,
  /%TEMP%[^"\s'`]*/gi,
];
const ROOT =
  /\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?|\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?|\/root(?:\/[^\s"'`]*)?|\/var\/folders\/[^/]+\/T(?:\/[^\s"'`]*)?|\/tmp\/(?:lando-)?[^/\s"'`]+(?:\/[^\s"'`]*)?|[A-Za-z]:\\(?:Users|AppData\\Local\\Temp)[^"\s'`]*|%USERPROFILE%[^"\s'`]*|%TEMP%[^"\s'`]*/giu;
const PORT_PATTERN = /:(\d{2,5})\b/gu;
const CONTAINER_ID_PATTERN = /\b(?:[0-9a-f]{12}|[0-9a-f]{16,63})\b/giu;
const DIGEST_PATTERN = /\bsha256:[0-9a-f]{64}\b/giu;
const PROVIDER_ID_PATTERN = /\b([A-Za-z0-9_-]+[_-](?:web|app|db|svc)[_-][A-Za-z0-9_-]+)\b/gi;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactPaths = (text: string, env: TranscriptRedactionEnv): string => {
  let output = text.replace(FIXTURE_PATH, (_match, prefix: string) => `${prefix}${HOME}`);
  for (const pattern of GENERIC_PATHS) {
    output = output.replace(pattern, (match) => (/tmp|Temp/i.test(match) ? TMP : HOME));
  }
  const roots: Array<{ value: string; placeholder: string }> = [];
  if (env.home) roots.push({ value: env.home, placeholder: HOME });
  if (env.tmp) roots.push({ value: env.tmp, placeholder: TMP });
  for (const value of env.extraRoots ?? []) roots.push({ value, placeholder: HOME });
  roots.sort((left, right) => right.value.length - left.value.length);
  for (const { value, placeholder } of roots) {
    if (value) output = output.replace(new RegExp(escapeRegExp(value), "gi"), placeholder);
  }
  return output;
};

const portReplacement = (match: string, portText: string): string => {
  const port = Number(portText);
  if (!Number.isFinite(port) || WELL_KNOWN_PORTS.has(port) || port < 1024) return match;
  return `:${PORT}`;
};

export const redactTranscriptString = (
  text: string,
  env: TranscriptRedactionEnv,
  redactSecrets: (value: string) => string,
): string => {
  if (!text) return text;
  let output = redactPaths(text, env);
  output = output.replace(PORT_PATTERN, portReplacement);
  output = output.replace(/\b([0-9a-f]{12})\b/gi, CONTAINER_ID);
  output = output.replace(/\b([0-9a-f]{16,63})\b/gi, CONTAINER_ID);
  output = output.replace(/\bsha256:([0-9a-f]{64})\b/gi, `sha256:${DIGEST}`);
  output = output.replace(PROVIDER_ID_PATTERN, PROVIDER_ID);
  if (env.user) output = output.replace(new RegExp(`\\b${escapeRegExp(env.user)}\\b`, "gi"), USER);
  if (env.host) output = output.replace(new RegExp(`\\b${escapeRegExp(env.host)}\\b`, "gi"), HOST);
  output = output
    .replace(SHORT_EQUALS_SECRET, (match, prefix: string, key: string, value: string) =>
      keepCompleteEnvPlaceholderOrRedact(match, `${prefix}${key}=${REDACTED}`, value),
    )
    .replace(SHORT_SPACE_SECRET, (match, prefix: string, key: string, value: string) =>
      keepCompleteEnvPlaceholderOrRedact(match, `${prefix}${key} ${REDACTED}`, value),
    )
    .replace(KEY_EQUALS_SECRET, (match, key: string, value: string) =>
      keepCompleteEnvPlaceholderOrRedact(match, `${key}=${REDACTED}`, value),
    )
    .replace(KEY_SPACE_SECRET, (match, key: string, value: string) =>
      keepCompleteEnvPlaceholderOrRedact(match, `${key} ${REDACTED}`, value),
    )
    .replace(TOKEN_SECRET_LITERAL, `token ${REDACTED}`);
  // Query masking belongs to the shared secrets pass, not a transcript copy.
  return redactSecrets(output);
};

export const TRANSCRIPT_PATTERN_CLASSES = {
  port: { pattern: PORT_PATTERN, replace: portReplacement },
  containerId: { pattern: CONTAINER_ID_PATTERN, replace: CONTAINER_ID },
  digest: { pattern: DIGEST_PATTERN, replace: `sha256:${DIGEST}` },
  providerId: { pattern: PROVIDER_ID_PATTERN, replace: PROVIDER_ID },
  root: { pattern: ROOT, replace: HOME },
} as const;
