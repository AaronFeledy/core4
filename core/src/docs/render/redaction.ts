import type { PublicTranscript, PublicTranscriptFrame } from "@lando/sdk/docs/components";
import { redactString } from "../../cli/redact.ts";

export interface RedactionEnvironment {
  readonly home?: string;
  readonly tmp?: string;
  readonly user?: string;
  readonly host?: string;
  readonly extraRoots?: readonly string[];
}

const PLACEHOLDERS = {
  HOME: "<HOME>",
  TMP: "<TMP>",
  USER: "<USER>",
  HOST: "<HOST>",
  PORT: "<PORT>",
  CONTAINER_ID: "<CONTAINER_ID>",
  PROVIDER_ID: "<PROVIDER_ID>",
  DIGEST: "<DIGEST>",
  REDACTED: "[REDACTED]",
} as const;

const WELL_KNOWN_PORTS = new Set([80, 443, 3000, 3306, 5432, 8080, 8443, 9000, 9229]);

const isEphemeralPort = (port: number): boolean => port >= 1024;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toGenericPathPatterns = (): RegExp[] => [
  /\/(?:home|Users|root|var\/folders\/[^/]+\/T)\/[^/\s"'`]+/gi,
  /\/tmp\/(?:lando-)?[^/\s"'`]+/gi,
  /[A-Za-z]:\\(?:Users|AppData\\Local\\Temp)[^"\s'`]*/gi,
  /%USERPROFILE%[^"\s'`]*/gi,
  /%TEMP%[^"\s'`]*/gi,
];

const redactPaths = (text: string, env: RedactionEnvironment): string => {
  let out = text;

  for (const re of toGenericPathPatterns()) {
    out = out.replace(re, (m) => (/tmp|Temp/i.test(m) ? PLACEHOLDERS.TMP : PLACEHOLDERS.HOME));
  }

  const roots: Array<{ value: string; placeholder: string }> = [];
  if (env.home) roots.push({ value: env.home, placeholder: PLACEHOLDERS.HOME });
  if (env.tmp) roots.push({ value: env.tmp, placeholder: PLACEHOLDERS.TMP });
  if (env.extraRoots?.length) {
    for (const r of env.extraRoots) roots.push({ value: r, placeholder: PLACEHOLDERS.HOME });
  }

  const sorted = [...roots].sort((a, b) => b.value.length - a.value.length);
  for (const { value, placeholder } of sorted) {
    if (!value) continue;
    const re = new RegExp(escapeRegExp(value), "gi");
    out = out.replace(re, placeholder);
  }

  return out;
};

const redactPorts = (text: string): string =>
  text.replace(/:(\d{2,5})\b/g, (_m, p) => {
    const port = Number(p);
    if (!Number.isFinite(port)) return _m;
    if (WELL_KNOWN_PORTS.has(port)) return _m;
    if (isEphemeralPort(port)) return `:${PLACEHOLDERS.PORT}`;
    return _m;
  });

const redactContainerIds = (text: string): string =>
  text
    .replace(/\b([0-9a-f]{12})\b/gi, PLACEHOLDERS.CONTAINER_ID)
    .replace(/\bsha256:([0-9a-f]{64})\b/gi, `sha256:${PLACEHOLDERS.DIGEST}`);

const redactProviderIds = (text: string): string =>
  text.replace(/\b([A-Za-z0-9_-]+[_-](?:web|app|db|svc)[_-][A-Za-z0-9_-]+)\b/gi, PLACEHOLDERS.PROVIDER_ID);

const redactLiterals = (text: string, env: RedactionEnvironment): string => {
  let out = text;
  if (env.user) {
    const re = new RegExp(`\\b${escapeRegExp(env.user)}\\b`, "gi");
    out = out.replace(re, PLACEHOLDERS.USER);
  }
  if (env.host) {
    const re = new RegExp(`\\b${escapeRegExp(env.host)}\\b`, "gi");
    out = out.replace(re, PLACEHOLDERS.HOST);
  }
  return out;
};

const redactBareSecrets = (text: string): string =>
  text
    .replace(
      /\b(token|secret|password|passwd|credential|bearer|apikey|api[_-]?key)\s*=\s*([^\s"'`&?]+)/giu,
      (_, key) => `${key}=${PLACEHOLDERS.REDACTED}`,
    )
    .replace(
      /\b(token|secret|password|passwd|credential|bearer|apikey|api[_-]?key)\s+([^\s"'`&?=]+)/giu,
      (_, key) => `${key} ${PLACEHOLDERS.REDACTED}`,
    )
    .replace(/\btoken\s+secret\b/gi, `token ${PLACEHOLDERS.REDACTED}`);

const redactQuerySecrets = (text: string): string =>
  text.replace(
    /([?&](?:[\w-]*[-_])?(?:access[_-]?token|token|secret|password|passwd|credential|signature|sig|api[_-]?key|apikey)=)([^&\s"']+)/giu,
    (_, prefix) => `${prefix}${PLACEHOLDERS.REDACTED}`,
  );

export const redactPublicTranscriptText = (text: string, env: RedactionEnvironment = {}): string => {
  if (!text) return text;

  let out = text;
  out = redactPaths(out, env);
  out = redactPorts(out);
  out = redactContainerIds(out);
  out = redactProviderIds(out);
  out = redactLiterals(out, env);
  out = redactBareSecrets(out);
  out = redactQuerySecrets(out);
  out = redactString(out);

  // Collapse any double redaction markers produced by composing multiple redactors.
  out = out.replace(/\[\s*REDACTED\s*\]\s*\]/gi, `[${PLACEHOLDERS.REDACTED}]`);

  return out;
};

const redactFrame = (frame: PublicTranscriptFrame, env: RedactionEnvironment): PublicTranscriptFrame => ({
  ...frame,
  displayText: frame.displayText ? redactPublicTranscriptText(frame.displayText, env) : frame.displayText,
  commandDisplay: frame.commandDisplay
    ? redactPublicTranscriptText(frame.commandDisplay, env)
    : frame.commandDisplay,
  resultSummary: frame.resultSummary
    ? redactPublicTranscriptText(frame.resultSummary, env)
    : frame.resultSummary,
});

export const redactPublicTranscript = (
  transcript: PublicTranscript,
  env: RedactionEnvironment = {},
): PublicTranscript => {
  if (!transcript) return transcript;
  return {
    ...transcript,
    frames: transcript.frames.map((f) => redactFrame(f, env)),
  };
};
