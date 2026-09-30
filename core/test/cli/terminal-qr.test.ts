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

describe("isLocalQrUrl", () => {
  test("treats *.lndo.site and 127.0.0.1 as local", () => {
    expect(isLocalQrUrl(LOCAL_SITE)).toBe(true);
    expect(isLocalQrUrl(LOOPBACK)).toBe(true);
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
  });

  test("local URLs need --qr", () => {
    expect(shouldRenderTerminalQr({ url: LOCAL_SITE, isTTY: true, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: LOOPBACK, isTTY: true, format: "text" })).toBe(false);
    expect(shouldRenderTerminalQr({ url: LOCAL_SITE, isTTY: false, format: "text", force: true })).toBe(true);
  });
});

describe("renderTerminalQr", () => {
  test("emits compact unicode for the URL", () => {
    const expected = renderUnicodeCompact(PUBLIC_URL);
    const rendered = renderTerminalQr(PUBLIC_URL);
    expect(rendered).toBe(expected.endsWith("\n") ? expected : `${expected}\n`);
    expect(rendered).toMatch(/[▀▄█]/u);
  });
});

describe("appendTerminalQr", () => {
  test("appends the QR after the existing line on a TTY", () => {
    const text = `Tunnel ready at ${PUBLIC_URL}\n`;
    const output = appendTerminalQr(text, { url: PUBLIC_URL, isTTY: true, format: "text" });
    expect(output.startsWith(text)).toBe(true);
    expect(output).toContain(renderTerminalQr(PUBLIC_URL).trimEnd());
  });

  test("leaves the line unchanged for a pipe", () => {
    const text = `Tunnel ready at ${PUBLIC_URL}\n`;
    expect(appendTerminalQr(text, { url: PUBLIC_URL, isTTY: false, format: "text" })).toBe(text);
  });
});
