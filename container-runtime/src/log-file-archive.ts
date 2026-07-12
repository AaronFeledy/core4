const encoder = new TextEncoder();
const tarBlockSize = 512;

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, "0");

const writeAscii = (target: Uint8Array, offset: number, value: string, length: number): void => {
  target.set(encoder.encode(value).slice(0, length), offset);
};

export const archiveLogFileHelper = (payload: Uint8Array): Uint8Array => {
  const header = new Uint8Array(tarBlockSize);
  writeAscii(header, 0, "lando-log-file-helper", 100);
  writeAscii(header, 100, `${octal(0o755, 8)}\0`, 8);
  writeAscii(header, 108, `${octal(0, 8)}\0`, 8);
  writeAscii(header, 116, `${octal(0, 8)}\0`, 8);
  writeAscii(header, 124, `${octal(payload.byteLength, 12)}\0`, 12);
  writeAscii(header, 136, `${octal(0, 12)}\0`, 12);
  header.fill(32, 148, 156);
  header[156] = 48;
  writeAscii(header, 257, "ustar", 6);
  writeAscii(header, 263, "00", 2);
  writeAscii(
    header,
    148,
    `${octal(
      header.reduce((sum, byte) => sum + byte, 0),
      7,
    )}\0 `,
    8,
  );
  const padded = Math.ceil(payload.byteLength / tarBlockSize) * tarBlockSize;
  const output = new Uint8Array(tarBlockSize + padded + tarBlockSize * 2);
  output.set(header, 0);
  output.set(payload, tarBlockSize);
  return output;
};
