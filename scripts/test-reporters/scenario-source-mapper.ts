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
  readonly sourcePath: string;
  readonly sourceLine: number;
  readonly guideId: string;
  readonly scenarioId: string;
}

interface MappedFrame {
  readonly originalLine: string;
  readonly prefix: string;
  readonly sourceFrame: string;
  readonly generatedFrame: string;
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
    const headers =
      source === null || scenarioId === null || guideId === null ? null : { ...source, guideId, scenarioId };
    headerCache.set(key, headers);
    return headers;
  } catch {
    headerCache.set(key, null);
    return null;
  }
};

const formatGeneratedPath = (filePath: string, repoRoot: string): string =>
  normalizePath(relative(repoRoot, filePath));

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

  return {
    originalLine: line,
    prefix: `[${headers.guideId}:${headers.scenarioId}]`,
    sourceFrame: `${indent}${headers.sourcePath}:${headers.sourceLine}`,
    generatedFrame: `${indent.replace(/at\s+$/, "")}Generated: ${formatGeneratedPath(filePath, repoRoot)}:${rawLine}:${rawColumn}`,
  };
};

const shouldPrefixFailureLine = (line: string): boolean =>
  line.startsWith("error: ") || /^\([^)]+Failure\) Error: /.test(line);

export const rewriteScenarioSourceMappedOutput = (output: string, options: RewriteOptions = {}): string => {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (options.disabled || process.env.LANDO_DISABLE_GUIDE_SOURCE_MAPPER === "1") return output;

  const lines = output.split("\n");
  const mapped = new Map<number, MappedFrame>();
  for (const [index, line] of lines.entries()) {
    const frame = mapStackLine(line, repoRoot);
    if (frame !== null) mapped.set(index, frame);
  }
  const firstMappedIndex = [...mapped.keys()][0];
  if (firstMappedIndex === undefined) return output;

  const prefix = mapped.get(firstMappedIndex)?.prefix;
  let prefixed = false;
  const rewritten: string[] = [];
  for (const [index, line] of lines.entries()) {
    const frame = mapped.get(index);
    if (frame !== undefined) {
      rewritten.push(frame.sourceFrame, frame.generatedFrame);
      continue;
    }
    if (!prefixed && prefix !== undefined && index < firstMappedIndex && shouldPrefixFailureLine(line)) {
      rewritten.push(`${prefix} ${line}`);
      prefixed = true;
      continue;
    }
    rewritten.push(line);
  }
  return rewritten.join("\n");
};

if (import.meta.main) {
  const input = await new Response(Bun.stdin.stream()).text();
  process.stdout.write(rewriteScenarioSourceMappedOutput(input));
}
