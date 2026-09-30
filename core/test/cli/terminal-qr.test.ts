import { describe, expect, test } from "bun:test";
import { renderUnicodeCompact } from "uqr";

import {
  appendTerminalQr,
  isLocalQrUrl,
  renderTerminalQr,
  shouldRenderTerminalQr,
} from "../../src/cli/terminal-qr.ts";

const PUBLIC_URL = "https://share.example.test";
const LOCAL_SITE = "https://web.myapp.lndo.site";
const LOOPBACK = "http://127.0.0.1:8080";
const LOCALHOST = "http://localhost:8080";
const IPV6_LOOPBACK = "http://[::1]:8080";
const OVERLONG_URL = `https://share.example.test/${"a".repeat(4000)}`;

const expectQr = (url: string): string => {
  const qr = renderTerminalQr(url);
  expect(qr).toBeDefined();
  return qr ?? "";
};

describe("isLocalQrUrl", () => {
  test("treats *.lndo.site, 127.0.0.1, localhost, and ::1 as local", () => {
    expect(isLocalQrUrl(LOCAL_SITE)).toBe(true);
    expect(isLocalQrUrl(LOOPBACK)).toBe(true);
    expect(isLocalQrUrl(LOCALHOST)).toBe(true);
    expect(isLocalQrUrl(IPV6_LOOPBACK)).toBe(true);
    expect(isLocalQrUrl(PUBLIC_URL)).toBe(false);
  });
});

describe("shouldRenderTerminalQr", () => {
  test("prints a public URL on a text TTY without --qr", () => {
    expect(shouldRenderTerminalQr({ url: PUBLIC_URL, isTTY: true, format: "text" })).toBe(true);
  });

  test("keeps pipes and envelope formats URL-only", () => {
    expect(shouldRenderTerminalQr({ url: PUBLIC_URL, isTTY: false, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: PUBLIC_URL, isTTY: true, format: "json" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: PUBLIC_URL, isTTY: true, format: "yaml" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: LOCAL_SITE, isTTY: false, format: "text", force: true })).toBe(
      false,
    );
  });

  test("local URLs need --qr on a TTY", () => {
    expect(shouldRenderTerminalQr({ url: LOCAL_SITE, isTTY: true, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: LOOPBACK, isTTY: true, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: LOCALHOST, isTTY: true, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: IPV6_LOOPBACK, isTTY: true, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: LOCAL_SITE, isTTY: true, format: "text", force: true })).toBe(true);
  });
});

describe("renderTerminalQr", () => {
  test("emits compact unicode for the URL", () => {
    const expected = renderUnicodeCompact(PUBLIC_URL);
    const rendered = expectQr(PUBLIC_URL);
    expect(rendered).toBe(expected.endsWith("\n") ? expected : `${expected}\n`);
    expect(rendered).toMatch(/[▀▄█]/u);
  });

  test("skips an overlong URL instead of throwing", () => {
    expect(renderTerminalQr(OVERLONG_URL)).toBeUndefined();
  });
});

describe("appendTerminalQr", () => {
  test("appends the QR after the existing line on a TTY", () => {
    const text = `Tunnel ready at ${PUBLIC_URL}\n`;
    const output = appendTerminalQr(text, { url: PUBLIC_URL, isTTY: true, format: "text" });
    expect(output.startsWith(text)).toBe(true);
    expect(output).toContain(expectQr(PUBLIC_URL).trimEnd());
  });

  test("leaves the line unchanged for a pipe", () => {
    const text = `Tunnel ready at ${PUBLIC_URL}\n`;
    expect(appendTerminalQr(text, { url: PUBLIC_URL, isTTY: false, format: "text" })).toBe(text);
  });

  test("leaves the line unchanged when encoding fails", () => {
    const text = `Tunnel ready at ${OVERLONG_URL}\n`;
    expect(appendTerminalQr(text, { url: OVERLONG_URL, isTTY: true, format: "text" })).toBe(text);
  });
});
