#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const GENERATED_GUIDE_SEGMENT = "/test/scenarios/generated/guides/";
const STACK_FRAME_RE = /^(?<indent>\s+at\s+)(?<target>.+?\.ts):(?<line>\d+):(?<column>\d+)$/;

interface RewriteOptions {
  readonly repoRoot?: string;
  readonly disabled?: boolean;
}

interface SourceHeaders {
  readonly sourcePath: string | null;
  readonly sourceLine: number | null;
  readonly guideId: string | null;
  readonly scenarioId: string | null;
}

interface MappedFrame {
  readonly originalLine: string;
  readonly prefix: string;
  readonly sourcePath: string | null;
  readonly sourceLine: number | null;
  readonly guideId: string | null;
  readonly scenarioId: string | null;
  readonly sourceFrame: string | null;
  readonly generatedFrame: string;
  readonly warningFrame: string | null;
  readonly rerunCommand: string | null;
}

interface FailureAnnotation {
  readonly key: string;
  readonly sourcePath: string;
  readonly sourceLine: number;
  readonly title: string;
  readonly message: string;
}

const fileCache = new Map<string, ReadonlyArray<string>>();
const headerCache = new Map<string, SourceHeaders | null>();

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const readLines = (path: string): ReadonlyArray<string> => {
  const cached = fileCache.get(path);
  if (cached !== undefined) return cached;
  const lines = readFileSync(path, "utf8").split("\n");
  fileCache.set(path, lines);
  return lines;
};

const stripFileUrl = (target: string): string =>
  target.startsWith("file://") ? new URL(target).pathname : target;

const resolveFramePath = (target: string, repoRoot: string): string => {
  const path = stripFileUrl(target);
  if (path.startsWith("/")) return path;
  return resolve(repoRoot, path);
};

const findSourceHeader = (
  lines: ReadonlyArray<string>,
  line: number,
): Pick<SourceHeaders, "sourcePath" | "sourceLine"> | null => {
  for (let index = Math.min(line - 1, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index]?.match(/^\s*\/\/ @source: (.+):(\d+)\s*$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { sourcePath: match[1], sourceLine: Number.parseInt(match[2], 10) };
    }
  }
  return null;
};

const findScenarioId = (lines: ReadonlyArray<string>, line: number): string | null => {
  for (let index = Math.min(line - 1, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index]?.match(/^\s*\/\/ @scenario: (.+)\s*$/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
};

const findGuideId = (lines: ReadonlyArray<string>): string | null => {
  const content = lines.join("\n");
  return content.match(/withScenarioContext\(\{ guideId: "([^"]+)"/)?.[1] ?? null;
};

const sourceHeadersForFrame = (filePath: string, line: number): SourceHeaders | null => {
  const key = `${filePath}:${line}`;
  if (headerCache.has(key)) return headerCache.get(key) ?? null;

  try {
    const lines = readLines(filePath);
    const source = findSourceHeader(lines, line);
    const scenarioId = findScenarioId(lines, line);
    const guideId = findGuideId(lines);
    const headers = {
      sourcePath: source?.sourcePath ?? null,
      sourceLine: source?.sourceLine ?? null,
      guideId,
      scenarioId,
    };
    headerCache.set(key, headers);
    return headers;
  } catch {
    headerCache.set(key, null);
    return null;
  }
};

const formatGeneratedPath = (filePath: string, repoRoot: string): string =>
  normalizePath(relative(repoRoot, filePath));

const missingHeaderNames = (headers: SourceHeaders): ReadonlyArray<string> => {
  const missing: string[] = [];
  if (headers.sourcePath === null || headers.sourceLine === null) missing.push("@source");
  if (headers.scenarioId === null) missing.push("@scenario");
  if (headers.guideId === null) missing.push("guideId");
  return missing;
};

const rerunCommandForHeaders = (headers: SourceHeaders): string | null => {
  if (headers.guideId === null) return null;
  if (headers.sourcePath !== null && headers.sourceLine !== null && headers.scenarioId !== null) {
    return `bun run docs:scenario ${headers.guideId} --scenario ${headers.scenarioId}`;
  }
  return `bun run docs:scenario ${headers.guideId}`;
};

const escapeAnnotationMessage = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeAnnotationProperty = (value: string): string =>
  escapeAnnotationMessage(value).replaceAll(",", "%2C").replaceAll(":", "%3A");

const annotationTitleForHeaders = (headers: SourceHeaders): string => {
  const parts = [headers.guideId, headers.scenarioId].filter((part): part is string => part !== null);
  return parts.length === 0 ? "guide-scenario" : parts.join(":");
};

const annotationLine = (annotation: FailureAnnotation): string =>
  `::error file=${escapeAnnotationProperty(annotation.sourcePath)},line=${escapeAnnotationProperty(String(annotation.sourceLine))},title=${escapeAnnotationProperty(annotation.title)}::${escapeAnnotationMessage(annotation.message)}`;

const mapStackLine = (line: string, repoRoot: string): MappedFrame | null => {
  const match = line.match(STACK_FRAME_RE);
  const target = match?.groups?.target;
  const rawLine = match?.groups?.line;
  const rawColumn = match?.groups?.column;
  const indent = match?.groups?.indent;
  if (target === undefined || rawLine === undefined || rawColumn === undefined || indent === undefined)
    return null;

  const filePath = resolveFramePath(target, repoRoot);
  if (!normalizePath(filePath).includes(GENERATED_GUIDE_SEGMENT)) return null;

  const generatedLine = Number.parseInt(rawLine, 10);
  const headers = sourceHeadersForFrame(filePath, generatedLine);
  if (headers === null) return null;
  const missing = missingHeaderNames(headers);
  const sourceFrame =
    headers.sourcePath === null || headers.sourceLine === null
      ? null
      : `${indent}${headers.sourcePath}:${headers.sourceLine}`;

  return {
    originalLine: line,
    prefix:
      headers.guideId !== null && headers.scenarioId !== null
        ? `[${headers.guideId}:${headers.scenarioId}]`
        : "",
    sourcePath: headers.sourcePath,
    sourceLine: headers.sourceLine,
    guideId: headers.guideId,
    scenarioId: headers.scenarioId,
    sourceFrame,
    generatedFrame: `${indent.replace(/at\s+$/, "")}Generated: ${formatGeneratedPath(filePath, repoRoot)}:${rawLine}:${rawColumn}`,
    warningFrame:
      missing.length === 0
        ? null
        : `${indent.replace(/at\s+$/, "")}GuideSourceMapWarning: missing ${missing.join(", ")} header; using fallback re-run command`,
    rerunCommand: rerunCommandForHeaders(headers),
  };
};

const shouldPrefixFailureLine = (line: string): boolean =>
  line.startsWith("error: ") || /^\([^)]+Failure\) Error: /.test(line);

const failureMessageForFrame = (
  lines: ReadonlyArray<string>,
  failureLineIndex: number,
  frameLineIndex: number,
): string => {
  const messageLines: string[] = [];
  for (let index = failureLineIndex; index < frameLineIndex; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (/^\s+at\s+/.test(line)) break;
    messageLines.push(line);
  }
  return messageLines.join("\n").trim() || lines[failureLineIndex] || "Guide scenario failed";
};

const annotationForFrame = (
  frame: MappedFrame,
  lines: ReadonlyArray<string>,
  failureLineIndex: number,
  frameLineIndex: number,
): FailureAnnotation | null => {
  if (frame.sourcePath === null || frame.sourceLine === null) return null;
  const title = annotationTitleForHeaders(frame);
  return {
    key: `${title}:${frame.sourceLine}`,
    sourcePath: frame.sourcePath,
    sourceLine: frame.sourceLine,
    title,
    message: failureMessageForFrame(lines, failureLineIndex, frameLineIndex),
  };
};

export const rewriteScenarioSourceMappedOutput = (output: string, options: RewriteOptions = {}): string => {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (options.disabled || process.env.LANDO_DISABLE_GUIDE_SOURCE_MAPPER === "1") return output;

  const lines = output.split("\n");
  const mapped = new Map<number, MappedFrame>();
  for (const [index, line] of lines.entries()) {
    const frame = mapStackLine(line, repoRoot);
    if (frame !== null) mapped.set(index, frame);
  }
  if (mapped.size === 0) return output;

  const prefixByLineIndex = new Map<number, string>();
  const annotations = new Map<string, FailureAnnotation>();
  let pendingFailureLineIndex: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (shouldPrefixFailureLine(line)) pendingFailureLineIndex = index;
    const frame = mapped.get(index);
    if (frame === undefined || pendingFailureLineIndex === undefined) continue;
    if (frame.prefix !== "" && !prefixByLineIndex.has(pendingFailureLineIndex)) {
      prefixByLineIndex.set(pendingFailureLineIndex, frame.prefix);
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      const annotation = annotationForFrame(frame, lines, pendingFailureLineIndex, index);
      if (annotation !== null && !annotations.has(annotation.key))
        annotations.set(annotation.key, annotation);
    }
    pendingFailureLineIndex = undefined;
  }

  const rewritten: string[] = [];
  let pendingRerunCommand: string | null = null;
  for (const [index, line] of lines.entries()) {
    const frame = mapped.get(index);
    if (frame !== undefined) {
      if (frame.sourceFrame !== null) rewritten.push(frame.sourceFrame);
      else rewritten.push(frame.originalLine);
      rewritten.push(frame.generatedFrame);
      if (frame.warningFrame !== null) rewritten.push(frame.warningFrame);
      pendingRerunCommand = frame.rerunCommand;
      continue;
    }
    const prefix = prefixByLineIndex.get(index);
    if (prefix !== undefined) {
      rewritten.push(`${prefix} ${line}`);
      if (pendingRerunCommand !== null && line.startsWith("(fail) ")) {
        rewritten.push(`Re-run: ${pendingRerunCommand}`);
        pendingRerunCommand = null;
      }
      continue;
    }
    rewritten.push(line);
    if (pendingRerunCommand !== null && line.startsWith("(fail) ")) {
      rewritten.push(`Re-run: ${pendingRerunCommand}`);
      pendingRerunCommand = null;
    }
  }
  if (pendingRerunCommand !== null) rewritten.push(`Re-run: ${pendingRerunCommand}`);
  const rewrittenOutput = rewritten.join("\n");
  if (annotations.size === 0) return rewrittenOutput;
  const annotationOutput = [...annotations.values()].map(annotationLine).join("\n");
  return rewrittenOutput.endsWith("\n")
    ? `${rewrittenOutput}${annotationOutput}`
    : `${rewrittenOutput}\n${annotationOutput}`;
};

if (import.meta.main) {
  const input = await new Response(Bun.stdin.stream()).text();
  process.stdout.write(rewriteScenarioSourceMappedOutput(input));
}
