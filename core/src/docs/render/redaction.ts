import { homedir, hostname, tmpdir, userInfo } from "node:os";

import type { PublicTranscript, PublicTranscriptFrame } from "@lando/sdk/docs/components";
import { type TranscriptRedactionEnv, createRedactor } from "@lando/sdk/secrets";

export type RedactionEnvironment = TranscriptRedactionEnv;

const defaultRedactionEnvironment = (env: RedactionEnvironment): RedactionEnvironment => ({
  home: env.home ?? homedir(),
  tmp: env.tmp ?? tmpdir(),
  user: env.user ?? userInfo().username,
  host: env.host ?? hostname(),
  extraRoots: env.extraRoots ?? [],
});

export const redactPublicTranscriptText = (text: string, env: RedactionEnvironment = {}): string => {
  if (!text) return text;
  const resolvedEnv = defaultRedactionEnvironment(env);
  return createRedactor("transcript", { env: resolvedEnv }).redactString(text);
};

const redactFrame = (frame: PublicTranscriptFrame, env: RedactionEnvironment): PublicTranscriptFrame => ({
  ...frame,
  sourceFile: redactPublicTranscriptText(frame.sourceFile, env),
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
