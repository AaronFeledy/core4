type Node = { readonly children: Map<number, Node>; terminal: boolean };

/** Strings are indexed by UTF-16 code unit, never by Unicode code point. */
export function* stringUnits(value: string): Iterable<number> {
  for (let index = 0; index < value.length; index += 1) yield value.charCodeAt(index);
}

/** Shared literal occurrence search over UTF-16 units or raw UTF-8 bytes. */
export class LiteralMatcher {
  readonly #root: Node = { children: new Map(), terminal: false };
  readonly #starts: RegExp;

  constructor(values: Iterable<Iterable<number>>) {
    for (const value of values) {
      let node = this.#root;
      for (const unit of value) {
        let next = node.children.get(unit);
        if (next === undefined) {
          next = { children: new Map(), terminal: false };
          node.children.set(unit, next);
        }
        node = next;
      }
      if (node !== this.#root) node.terminal = true;
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
    marker = -1,
  ): {
    readonly end: number;
    readonly partial: boolean;
  } {
    let node = this.#root;
    let cursor = start;
    let end = start;
    while (cursor < input.length) {
      if (cursor === marker && cursor > start && node.children.size > 0) {
        return { end: cursor, partial: false };
      }
      const unit = typeof input === "string" ? input.charCodeAt(cursor) : input[cursor];
      const next = unit === undefined ? undefined : node.children.get(unit);
      if (next === undefined) return { end, partial: false };
      node = next;
      cursor += 1;
      if (node.terminal) end = cursor;
    }
    return { end, partial: cursor > start && node.children.size > 0 };
  }
}
