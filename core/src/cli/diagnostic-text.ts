const isTerminalControl = (codePoint: number): boolean =>
  (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);

export const escapeDiagnosticText = (text: string): string =>
  Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && isTerminalControl(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }).join("");

const ESC = String.fromCharCode(27);
const dimLine = (line: string): string => `${ESC}[2m${line}${ESC}[22m`;

/** Dim secondary diagnostic lines. Call only after redaction on a TTY lando surface. */
export const dimBugReportDetails = (text: string): string => {
  const lines = text.split("\n");
  const detailsStart = lines.findIndex((line) => line.startsWith("code: "));
  if (detailsStart === -1) return text;
  let additional = false;
  let additionalDetails = false;
  return lines
    .map((line, index) => {
      if (index >= detailsStart) return dimLine(line);
      if (/^(?:Rollback also failed|Cleanup also failed|Also failed) \(/u.test(line)) {
        additional = true;
        additionalDetails = false;
        return line;
      }
      // Details follow the remediation; a block without remediation stays undimmed.
      if (additional && line.startsWith("  ↳ ")) {
        additionalDetails = true;
        return line;
      }
      return additionalDetails ? dimLine(line) : line;
    })
    .join("\n");
};
