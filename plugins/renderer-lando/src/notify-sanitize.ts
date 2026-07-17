/**
 * Fixed sanitizer applied to notify.desktop title/body before triggerNotification.
 * SPEC: §8.9.7
 */

const isC0OrC1 = (code: number): boolean => (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);

const isBidiOverride = (code: number): boolean =>
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

export const sanitizeNotificationText = (value: string): string => {
  let out = "";
  for (const char of value) {
    if (char === "\r" || char === "\n" || char === "\t") {
      out += " ";
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (isC0OrC1(code) || isBidiOverride(code)) continue;
    out += char;
  }
  return out.normalize("NFC");
};
