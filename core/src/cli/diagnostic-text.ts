const isTerminalControl = (codePoint: number): boolean =>
  (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);

export const escapeDiagnosticText = (text: string): string =>
  Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && isTerminalControl(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
