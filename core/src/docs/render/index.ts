import { join } from "node:path";

import { PublicTranscript, type PublicTranscriptFrame } from "@lando/core/schema";
import { Either, type ParseResult, Schema } from "effect";

import { type RedactionEnvironment, redactPublicTranscript } from "./redaction";

export {
  redactPublicTranscript,
  redactPublicTranscriptText,
  type RedactionEnvironment,
} from "./redaction";

export const decodePublicTranscriptEither = (
  input: unknown,
): Either.Either<PublicTranscript, ParseResult.ParseError> =>
  Schema.decodeUnknownEither(PublicTranscript)(input);

export interface SourceLinkOptions {
  readonly sourceLinkBase?: string;
}

export interface RenderOptions extends SourceLinkOptions {
  readonly redactionEnv?: RedactionEnvironment;
}

export class InvalidSourceLinkBaseError extends Schema.TaggedError<InvalidSourceLinkBaseError>()(
  "InvalidSourceLinkBaseError",
  {
    message: Schema.String,
    sourceLinkBase: Schema.String,
    remediation: Schema.String,
  },
) {}

export class InvalidSourceFileError extends Schema.TaggedError<InvalidSourceFileError>()(
  "InvalidSourceFileError",
  {
    message: Schema.String,
    sourceFile: Schema.String,
    remediation: Schema.String,
  },
) {}

const SOURCE_LINK_BASE_REMEDIATION =
  "Set LANDO_DOCS_SOURCE_LINK_BASE to an https:// repository blob base URL." as const;
const SOURCE_FILE_REMEDIATION =
  "Use a repository-relative path such as docs/guides/example.mdx with no scheme, traversal, or absolute prefix." as const;

const hasControlChars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/** Parse and require an `https:` source-link base (scheme case is normalized by URL). */
export const assertHttpsSourceLinkBase = (sourceLinkBase: string): string => {
  const trimmed = sourceLinkBase.trim();

  let parsed: URL;
  try {
    // WHATWG URL lowercases the scheme, so mixed-case HTTPS:// is accepted here.
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidSourceLinkBaseError({
      message: `sourceLinkBase is not a valid URL: ${trimmed}`,
      sourceLinkBase: trimmed,
      remediation: SOURCE_LINK_BASE_REMEDIATION,
    });
  }

  if (parsed.protocol !== "https:") {
    throw new InvalidSourceLinkBaseError({
      message: `sourceLinkBase must use the https: protocol: ${trimmed}`,
      sourceLinkBase: trimmed,
      remediation: SOURCE_LINK_BASE_REMEDIATION,
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InvalidSourceLinkBaseError({
      message: `sourceLinkBase must not include credentials: ${trimmed}`,
      sourceLinkBase: trimmed,
      remediation: SOURCE_LINK_BASE_REMEDIATION,
    });
  }
  if (parsed.hostname === "") {
    throw new InvalidSourceLinkBaseError({
      message: `sourceLinkBase must include a hostname: ${trimmed}`,
      sourceLinkBase: trimmed,
      remediation: SOURCE_LINK_BASE_REMEDIATION,
    });
  }

  // Serialize via href so the scheme is canonical lowercase https.
  return parsed.href.replace(/\/+$/, "");
};

/** Require a repository-relative path safe to append under a source-link base. */
export const assertRepositoryRelativeSourceFile = (sourceFile: string): string => {
  const fail = (detail: string): never => {
    throw new InvalidSourceFileError({
      message: detail,
      sourceFile,
      remediation: SOURCE_FILE_REMEDIATION,
    });
  };

  if (sourceFile.length === 0) {
    fail("sourceFile must not be empty");
  }
  if (hasControlChars(sourceFile)) {
    fail(`sourceFile must not contain control characters: ${JSON.stringify(sourceFile)}`);
  }
  if (sourceFile.includes("\\")) {
    fail(`sourceFile must use forward slashes only: ${sourceFile}`);
  }
  if (sourceFile.startsWith("/")) {
    fail(`sourceFile must be repository-relative, not absolute: ${sourceFile}`);
  }
  if (/^[A-Za-z]:/.test(sourceFile)) {
    fail(`sourceFile must be repository-relative, not a drive path: ${sourceFile}`);
  }
  if (sourceFile.includes("?") || sourceFile.includes("#")) {
    fail(`sourceFile must not include query or fragment: ${sourceFile}`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(sourceFile)) {
    fail(`sourceFile must not include a URI scheme: ${sourceFile}`);
  }

  const segments = sourceFile.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`sourceFile must not contain empty, '.', or '..' segments: ${sourceFile}`);
  }

  return sourceFile;
};

const transcriptPathFor = (args: {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
}): string => {
  const suffix =
    args.variant === ""
      ? ""
      : `.${args.variant
          .split(" ")
          .map((pair) => pair.split("=")[1] ?? "")
          .join(".")}`;
  return join("dist", "transcripts", "public", "guides", args.guideId, `${args.scenarioId}${suffix}.json`);
};

export const frameSourceHref = (frame: PublicTranscriptFrame, options?: SourceLinkOptions): string => {
  const sourceFile = assertRepositoryRelativeSourceFile(frame.sourceFile);
  const relativeHref = `${sourceFile}#L${frame.sourceLine}`;
  const base = options?.sourceLinkBase;

  if (typeof base !== "string" || base.trim() === "") return relativeHref;
  return `${assertHttpsSourceLinkBase(base)}/${relativeHref}`;
};

export interface PublicTranscriptViewFrame {
  readonly kind: PublicTranscriptFrame["kind"];
  readonly displayText?: string;
  readonly commandDisplay?: string;
  readonly resultSummary?: string;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly sourceHref: string;
}

export interface PublicTranscriptView {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
  readonly runtime: string;
  readonly frames: ReadonlyArray<PublicTranscriptViewFrame>;
}

export const toPublicTranscriptView = (
  transcript: PublicTranscript,
  options?: RenderOptions,
): PublicTranscriptView => {
  const redacted = redactPublicTranscript(transcript, options?.redactionEnv);
  return {
    guideId: redacted.guideId,
    scenarioId: redacted.scenarioId,
    variant: redacted.variant,
    runtime: redacted.runtime,
    frames: redacted.frames.map((frame) => ({
      kind: frame.kind,
      ...(frame.displayText === undefined ? {} : { displayText: frame.displayText }),
      ...(frame.commandDisplay === undefined ? {} : { commandDisplay: frame.commandDisplay }),
      ...(frame.resultSummary === undefined ? {} : { resultSummary: frame.resultSummary }),
      sourceFile: frame.sourceFile,
      sourceLine: frame.sourceLine,
      sourceHref: frameSourceHref(frame, options),
    })),
  };
};

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const renderFrameHtml = (frame: PublicTranscriptViewFrame): string => {
  const display =
    frame.displayText === undefined
      ? ""
      : `<span class="lando-frame__display">${escapeHtml(frame.displayText)}</span>`;
  const command =
    frame.commandDisplay === undefined
      ? ""
      : `<code class="lando-frame__command">${escapeHtml(frame.commandDisplay)}</code>`;
  const result =
    frame.resultSummary === undefined
      ? ""
      : `<span class="lando-frame__result">${escapeHtml(frame.resultSummary)}</span>`;
  const sourceLabel = `${frame.sourceFile}:${frame.sourceLine}`;

  return `<div class="lando-frame lando-frame--${escapeHtml(frame.kind)}" data-source-file="${escapeHtml(frame.sourceFile)}" data-source-line="${frame.sourceLine}">${display}${command}${result}<a class="lando-frame__source" href="${escapeHtml(frame.sourceHref)}">${escapeHtml(sourceLabel)}</a></div>`;
};

export const renderPublicTranscriptHtml = (transcript: PublicTranscript, options?: RenderOptions): string => {
  const view = toPublicTranscriptView(transcript, options);
  const frames = view.frames.map(renderFrameHtml).join("");

  return `<div class="lando-transcript" data-guide-id="${escapeHtml(view.guideId)}" data-scenario-id="${escapeHtml(view.scenarioId)}" data-variant="${escapeHtml(view.variant)}" data-runtime="${escapeHtml(view.runtime)}">${frames}</div>`;
};

export const loadPublicTranscript = async (args: {
  readonly root: string;
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: string;
}): Promise<PublicTranscript> => {
  const transcriptPath = join(args.root, transcriptPathFor(args));
  const input = await Bun.file(transcriptPath).json();
  const decoded = decodePublicTranscriptEither(input);

  if (Either.isLeft(decoded)) {
    throw new Error(`Failed to decode public transcript at ${transcriptPath}`);
  }

  return redactPublicTranscript(decoded.right);
};
