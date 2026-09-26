import type {
  LegacyNode,
  LegacyScalarNode,
  LegacyScalarStyle,
  LegacySourcePosition,
  LegacySourceSpan,
} from "./contract.ts";
import { legacyParseError } from "./errors.ts";
import type { ResolvedLegacyLimits } from "./limits.ts";

export class LegacyScanner {
  offset = 0;
  aliasCount = 0;
  readonly anchors = new Map<string, LegacyNode>();
  readonly definedAnchors = new Set<string>();
  private readonly starts = [0];

  constructor(
    readonly content: string,
    readonly file: string,
    readonly limits: ResolvedLegacyLimits,
  ) {
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "\r") {
        if (content[index + 1] === "\n") index += 1;
        this.starts.push(index + 1);
      } else if (content[index] === "\n") this.starts.push(index + 1);
    }
  }

  get char(): string {
    return this.content[this.offset] ?? "";
  }
  get done(): boolean {
    return this.offset >= this.content.length;
  }
  get atBreak(): boolean {
    return this.char === "\n" || this.char === "\r";
  }

  position(offset = this.offset): LegacySourcePosition {
    let low = 0;
    let high = this.starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - (this.starts[low] ?? 0) + 1, offset };
  }

  span(start: number, end = this.offset): LegacySourceSpan {
    return { start: this.position(start), end: this.position(end) };
  }

  fail(
    message: string,
    offset = this.offset,
    remediation = "Correct the YAML syntax at this location and retry.",
  ): never {
    throw legacyParseError(this.file, message, this.position(offset), remediation);
  }

  depth(depth: number): void {
    if (depth > this.limits.maxDepth) {
      this.fail(
        `Landofile nesting depth exceeds the maximum depth of ${this.limits.maxDepth}.`,
        this.offset,
        "Reduce block and flow nesting or raise the configured maximum depth.",
      );
    }
  }

  spaces(): void {
    while (this.char === " " || this.char === "\t") this.offset += 1;
  }

  lineEnd(offset = this.offset): number {
    let low = 0;
    let high = this.starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle;
    }
    const next = this.starts[low + 1];
    if (next === undefined) return this.content.length;
    // `next` is the first character of the following line, after the break.
    let end = next - 1;
    if (end > 0 && this.content[end] === "\n" && this.content[end - 1] === "\r") end -= 1;
    return end;
  }

  nextLine(): void {
    this.offset = this.lineEnd();
    if (this.char === "\r") this.offset += 1;
    if (this.char === "\n") this.offset += 1;
  }

  finishLine(): void {
    this.spaces();
    if (!this.done && !this.atBreak && this.char !== "#") this.fail("Unexpected text after YAML value.");
    this.nextLine();
  }

  significant(): void {
    while (!this.done) {
      while (this.char === " ") this.offset += 1;
      if (this.char === "\t")
        this.fail("Tab indentation is not supported.", this.offset, "Use spaces for YAML indentation.");
      if (this.atBreak || this.char === "#") this.nextLine();
      else break;
    }
  }

  structural(): void {
    // Markers below are at most 5 characters. One extra character keeps `$`
    // from matching a truncated slice when the line continues.
    const end = Math.min(this.lineEnd(), this.offset + 6);
    const text = this.content.slice(this.offset, end);
    if (/^(---|\.\.\.)(?:\s|$)/.test(text)) {
      this.fail(
        "Multiple YAML documents and document end markers are not supported.",
        this.offset,
        "Keep one document and remove additional document markers.",
      );
    }
    if (/^%(YAML|TAG)(?:\s|$)/.test(text)) {
      this.fail(
        "YAML directives are not supported.",
        this.offset,
        "Remove the directive and use ordinary YAML nodes.",
      );
    }
    if (/^\?(?:\s|$)/.test(text))
      this.fail(
        "Complex keys are not supported.",
        this.offset,
        "Use a scalar mapping key instead of an explicit complex key.",
      );
  }

  flowSpace(): void {
    while (!this.done) {
      this.spaces();
      if (this.char === "#" || this.atBreak) {
        this.nextLine();
        this.significant();
      } else break;
    }
    this.structural();
  }

  scalar(text: string, style: LegacyScalarStyle, start: number): LegacyScalarNode {
    return { kind: "scalar", text, style, anchor: undefined, tag: undefined, span: this.span(start) };
  }

  mappingColon(): number {
    let index = this.offset;
    const end = this.lineEnd();
    const quote = this.content[index];
    if (quote === "'" || quote === '"') {
      index += 1;
      while (index < end) {
        const char = this.content[index];
        index += 1;
        if (char === "\\" && quote === '"') index += 1;
        else if (char === quote) {
          if (quote === "'" && this.content[index] === "'") index += 1;
          else break;
        }
      }
      while (this.content[index] === " " || this.content[index] === "\t") index += 1;
      return this.content[index] === ":" ? index : -1;
    }
    if (quote === "[" || quote === "{" || quote === "|" || quote === ">") return -1;
    for (; index < end; index += 1) {
      const char = this.content[index];
      if (char === "#" && (index === this.offset || /\s/.test(this.content[index - 1] ?? ""))) break;
      if (char === ":" && /\s|^$/.test(this.content[index + 1] ?? "")) return index;
    }
    return -1;
  }

  uniqueKey(keys: Map<string, number>, key: LegacyScalarNode): void {
    const first = keys.get(key.text);
    if (first !== undefined) {
      this.fail(
        `Duplicate YAML mapping key "${key.text}" at lines ${first} and ${key.span.start.line}.`,
        key.span.start.offset,
        "Remove or rename the second explicit mapping key.",
      );
    }
    keys.set(key.text, key.span.start.line);
  }
}
