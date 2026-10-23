import { emitLandofileYamlEither } from "@lando/sdk/landofile";
import { Result } from "effect";
import { getAtPath, parsePathSegments } from "./dot-path";
import {
  type UnsupportedEdit,
  locateYamlEdit,
  scanYamlLines,
  subtreeHasAnchor,
  unsupported,
} from "./yaml-locate";

export interface YamlEdit {
  readonly source: string;
  readonly key: string;
  readonly next: unknown;
  readonly operation: "set" | "unset";
}

const fragment = (key: string, value: unknown, indent: number, ending: string) => {
  const emitted = emitLandofileYamlEither({ [key]: value });
  if (Result.isFailure(emitted)) return unsupported(emitted.failure.message);
  return Result.succeed(
    emitted.success
      .trimEnd()
      .split("\n")
      .map((line) => " ".repeat(indent) + line)
      .join(ending),
  );
};

export const spliceYamlEdit = (input: YamlEdit): Result.Result<string, UnsupportedEdit> => {
  const scanned = scanYamlLines(input.source);
  if (Result.isFailure(scanned)) return Result.fail(scanned.failure);
  const segments = parsePathSegments(input.key);
  if (segments === undefined) return unsupported("Malformed edit path.");
  const located = locateYamlEdit(scanned.success, segments);
  if (Result.isFailure(located)) return Result.fail(located.failure);
  const { entry, parent, remaining, entries, indent, emptyFlowParent } = located.success;
  const ending = input.source.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const splice = (start: number, end: number, text: string) => {
    const next = input.source.slice(0, start) + text + input.source.slice(end);
    return Result.succeed(
      end === input.source.length && input.source !== "" && !/[\r\n]$/.test(input.source)
        ? next.replace(/(?:\r\n|\r|\n)$/, "")
        : next,
    );
  };
  if (entry === undefined) {
    if (input.operation === "unset") return Result.succeed(input.source);
    const first = remaining[0];
    if (first?.kind !== "key") return unsupported("Cannot create a list index.");
    const prefix = segments
      .slice(0, segments.length - remaining.length + 1)
      .map((segment) => (segment.kind === "key" ? segment.key : `[${segment.index}]`))
      .join(".");
    const emitted = fragment(first.key, getAtPath(input.next, prefix), indent, ending);
    if (Result.isFailure(emitted)) return Result.fail(emitted.failure);
    if (emptyFlowParent === true && parent !== undefined) {
      let start = parent.valueStart;
      while (start > 0 && input.source[start - 1] === " ") start -= 1;
      const comment = input.source.slice(parent.valueEnd, parent.line.contentEnd).trim();
      const newline = parent.line.end > parent.line.contentEnd ? ending : "";
      return splice(
        start,
        parent.line.end,
        `${comment === "" ? "" : ` ${comment}`}${ending}${emitted.success}${newline}`,
      );
    }
    const offset = entries.at(-1)?.regionEnd ?? parent?.line.end ?? input.source.length;
    const lead = offset > 0 && !/[\r\n]$/.test(input.source.slice(0, offset)) ? ending : "";
    const tail =
      offset < input.source.length || /[\r\n]$/.test(input.source) || input.source === "" ? ending : "";
    return splice(offset, offset, lead + emitted.success + tail);
  }
  if (subtreeHasAnchor(entry))
    return unsupported("An anchor is defined inside the replaced or removed subtree.");
  const last = segments.at(-1);
  if (input.operation === "unset") {
    if (entries.length === 1 && parent !== undefined) {
      const gap = input.source[parent.valueStart - 1] === ":" ? " " : "";
      const suffix = input.source.slice(parent.valueEnd, parent.line.end);
      return splice(
        parent.valueStart,
        entry.regionEnd,
        `${gap}${last?.kind === "index" ? "[]" : "{}"}${suffix.startsWith("#") ? " " : ""}${suffix}`,
      );
    }
    return splice(entry.line.start, entry.regionEnd, "");
  }
  const value = getAtPath(input.next, input.key);
  if (last?.kind === "index" && value !== null && typeof value === "object")
    return unsupported("Only scalar block-list items can be replaced.");
  const emitted = fragment("value", value, 0, ending);
  if (Result.isFailure(emitted)) return Result.fail(emitted.failure);
  const rendered = emitted.success.slice("value:".length);
  const multiline = rendered.includes(ending);
  const inline = rendered.trimStart();
  const hasChildren = entry.children.some((line) => line.code.trim() !== "");
  const gap = input.source[entry.valueStart - 1] === ":" ? " " : "";
  const commentGap = input.source[entry.valueEnd] === "#" ? " " : "";
  if (!multiline && !hasChildren) return splice(entry.valueStart, entry.valueEnd, gap + inline + commentGap);
  const childText = multiline
    ? rendered
        .slice(rendered.indexOf(ending) + ending.length)
        .split(ending)
        .map((line) => " ".repeat(indent) + line)
        .join(ending)
    : "";
  const suffix = input.source.slice(entry.valueEnd, entry.line.contentEnd);
  const tail = /[\r\n]$/.test(input.source.slice(0, entry.regionEnd)) ? ending : "";
  if (!multiline) return splice(entry.valueStart, entry.regionEnd, gap + inline + commentGap + suffix + tail);
  const comment = suffix.trimStart();
  const keyEnd = input.source.lastIndexOf(":", entry.valueStart - 1) + 1;
  return splice(keyEnd, entry.regionEnd, (comment === "" ? "" : ` ${comment}`) + ending + childText + tail);
};
