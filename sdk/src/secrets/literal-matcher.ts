export type RedactionMatch = "substring" | "whole-token";

export interface TieredRedactionValues {
  readonly substring: Iterable<string>;
  readonly wholeToken: Iterable<string>;
}

export const isRedactionTokenBoundaryUnit = (unit: number | undefined): boolean =>
  unit === undefined ||
  !(
    unit >= 0x80 ||
    (unit >= 65 && unit <= 90) ||
    (unit >= 97 && unit <= 122) ||
    (unit >= 48 && unit <= 57) ||
    unit === 95 ||
    unit === 45 ||
    unit === 46 ||
    unit === 47
  );

type Node = {
  readonly children: Map<number, Node>;
  terminal?: RedactionMatch;
  substringBelow: boolean;
  wholeTokenBelow: boolean;
};

const makeNode = (): Node => ({ children: new Map(), substringBelow: false, wholeTokenBelow: false });

/** Strings are indexed by UTF-16 code unit, never by Unicode code point. */
export function* stringUnits(value: string): Iterable<number> {
  for (let index = 0; index < value.length; index += 1) yield value.charCodeAt(index);
}

/** Shared literal occurrence search over UTF-16 units or raw UTF-8 bytes. */
export class LiteralMatcher {
  readonly #root: Node = makeNode();
  readonly #starts: RegExp;

  constructor(values: Iterable<Iterable<number>>, wholeTokenValues: Iterable<Iterable<number>> = []) {
    for (const [mode, entries] of [
      ["whole-token", wholeTokenValues],
      ["substring", values],
    ] as const) {
      for (const value of entries) {
        let node = this.#root;
        for (const unit of value) {
          if (mode === "substring") node.substringBelow = true;
          else node.wholeTokenBelow = true;
          let next = node.children.get(unit);
          if (next === undefined) {
            next = makeNode();
            node.children.set(unit, next);
          }
          node = next;
        }
        if (node !== this.#root) node.terminal = mode;
      }
    }
    // Native candidate search skips runs that cannot start any value, without
    // allocating or byte-counting no-match string input.
    const units = [...this.#root.children.keys()].map((unit) => `\\u${unit.toString(16).padStart(4, "0")}`);
    this.#starts = new RegExp(units.length === 0 ? "(?!)" : `[${units.join("")}]`, "g");
  }

  nextStart(text: string, from: number): number {
    this.#starts.lastIndex = from;
    return this.#starts.exec(text)?.index ?? -1;
  }

  get empty(): boolean {
    return this.#root.children.size === 0;
  }

  /** Cheap pre-check so scans skip units that cannot begin any value. */
  canStart(unit: number | undefined): boolean {
    return unit !== undefined && this.#root.children.has(unit);
  }

  matchAt(
    input: string | Uint8Array,
    start: number,
    {
      marker = -1,
      leftBoundary = true,
      final = true,
      rightBoundary,
    }: {
      readonly marker?: number;
      readonly leftBoundary?: boolean;
      readonly final?: boolean;
      readonly rightBoundary?: (end: number) => boolean;
    } = {},
  ): {
    readonly end: number;
    readonly partial: boolean;
  } {
    let node = this.#root;
    let cursor = start;
    let end = start;
    while (cursor < input.length) {
      if (
        cursor === marker &&
        cursor > start &&
        (node.substringBelow || (leftBoundary && node.wholeTokenBelow))
      ) {
        return { end: cursor, partial: false };
      }
      const unit = typeof input === "string" ? input.charCodeAt(cursor) : input[cursor];
      const next = unit === undefined ? undefined : node.children.get(unit);
      if (next === undefined) return { end, partial: false };
      node = next;
      cursor += 1;
      if (node.terminal === "substring") end = cursor;
      else if (node.terminal === "whole-token" && leftBoundary) {
        if (cursor === input.length && !final) return { end, partial: true };
        const boundary =
          rightBoundary?.(cursor) ??
          isRedactionTokenBoundaryUnit(
            cursor === input.length
              ? undefined
              : typeof input === "string"
                ? input.charCodeAt(cursor)
                : input[cursor],
          );
        if (boundary) end = cursor;
      }
    }
    return {
      end,
      partial: !final && cursor > start && (node.substringBelow || (leftBoundary && node.wholeTokenBelow)),
    };
  }
}
