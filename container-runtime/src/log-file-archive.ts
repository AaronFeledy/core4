const encoder = new TextEncoder();
const tarBlockSize = 512;

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, "0");

const writeAscii = (target: Uint8Array, offset: number, value: string, length: number): void => {
  target.set(encoder.encode(value).slice(0, length), offset);
};

const tarHeader = (name: string, mode: number, size: number, typeflag: number): Uint8Array => {
  const header = new Uint8Array(tarBlockSize);
  writeAscii(header, 0, name, 100);
  writeAscii(header, 100, `${octal(mode, 8)}\0`, 8);
  writeAscii(header, 108, `${octal(0, 8)}\0`, 8);
  writeAscii(header, 116, `${octal(0, 8)}\0`, 8);
  writeAscii(header, 124, `${octal(size, 12)}\0`, 12);
  writeAscii(header, 136, `${octal(0, 12)}\0`, 12);
  header.fill(32, 148, 156);
  header[156] = typeflag;
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
  return header;
};

export const archiveLogFileHelper = (payload: Uint8Array, directoryName: string): Uint8Array => {
  const padded = Math.ceil(payload.byteLength / tarBlockSize) * tarBlockSize;
  const directoryHeader = tarHeader(`${directoryName}/`, 0o755, 0, 53);
  const fileHeader = tarHeader(`${directoryName}/lando-log-file-helper`, 0o755, payload.byteLength, 48);
  const output = new Uint8Array(tarBlockSize * 2 + padded + tarBlockSize * 2);
  output.set(directoryHeader, 0);
  output.set(fileHeader, tarBlockSize);
  output.set(payload, tarBlockSize * 2);
  return output;
};
