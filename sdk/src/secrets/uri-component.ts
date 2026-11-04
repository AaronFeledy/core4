/** RFC 3986 component encoding of UTF-8 bytes, shared by planning and redaction. */
export const encodeUriComponent = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) =>
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122) ||
    (byte >= 48 && byte <= 57) ||
    [45, 46, 95, 126].includes(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
