const CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const CODE_SPAN_PATTERN = /(`+[^`]*`+)/g;
const PLACEHOLDER_PATTERN = /<([a-z][a-z0-9]*(?:[-_ ][a-z0-9]+)*)>/g;

export const escapeReferenceMdxPlaceholders = (source: string): string => {
  let fenceMarker: "`" | "~" | undefined;

  return source
    .split("\n")
    .map((line) => {
      const marker = line.match(CODE_FENCE_PATTERN)?.[1]?.[0];
      if (marker === "`" || marker === "~") {
        fenceMarker = fenceMarker === marker ? undefined : (fenceMarker ?? marker);
        return line;
      }
      if (fenceMarker !== undefined) return line;

      return line
        .split(CODE_SPAN_PATTERN)
        .map((segment, index) =>
          index % 2 === 1 ? segment : segment.replace(PLACEHOLDER_PATTERN, "&lt;$1&gt;"),
        )
        .join("");
    })
    .join("\n");
};
