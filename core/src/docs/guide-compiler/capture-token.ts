const token = String.raw`\{\{capture:([^{}:\s]+)\}\}`;
const captureWord = new RegExp(`^${token}(?=[ \\t]|$)`, "u");

export const CAPTURE_ARG = new RegExp(`^${token}$`, "u");
export const captureWordAt = (command: string, index: number): string | undefined =>
  captureWord.exec(command.slice(index))?.[0];
