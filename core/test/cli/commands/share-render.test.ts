import { describe, expect, test } from "bun:test";

import { AppId, ServiceName, type TunnelSession } from "@lando/sdk/schema";

import { renderShareResult } from "../../../src/cli/commands/share.ts";
import { renderTerminalQr } from "../../../src/cli/terminal-qr.ts";
import type { RenderContext } from "../../../src/cli/renderer-boundary.ts";

const PUBLIC_URL = "https://share.example.test";
const LOCAL_URL = "https://web.myapp.lndo.site";

const session = (over: Partial<TunnelSession> = {}): TunnelSession => ({
  id: "tun1",
  app: AppId.make("myapp"),
  provider: "test-tunnel",
  target: { _tag: "service", service: ServiceName.make("web"), port: 80, protocol: "http" },
  publicUrl: PUBLIC_URL,
  status: "ready",
  detached: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  mode: "lando",
  format: "text",
  columns: 80,
  isTTY: true,
  ...over,
});

const tunnelLine = (url?: string): string =>
  `Tunnel tun1 ready via test-tunnel (web:80)${url === undefined ? "" : ` at ${url}`}\n`;

describe("renderShareResult", () => {
  test("text TTY with a public URL prints the tunnel line plus a QR", () => {
    const output = renderShareResult(session(), "text", ctx());
    expect(output.startsWith(tunnelLine(PUBLIC_URL))).toBe(true);
    expect(output).toContain(renderTerminalQr(PUBLIC_URL).trimEnd());
  });

  test("piped text stays the tunnel line only", () => {
    expect(renderShareResult(session(), "text", ctx({ isTTY: false }))).toBe(tunnelLine(PUBLIC_URL));
  });

  test("JSON format stays URL-only even on a TTY", () => {
    expect(renderShareResult(session(), "json", ctx({ format: "json" }))).toBe(tunnelLine(PUBLIC_URL));
  });

  test("omits a QR when publicUrl is absent", () => {
    const { publicUrl: _publicUrl, ...withoutUrl } = session();
    expect(renderShareResult(withoutUrl, "text", ctx())).toBe(tunnelLine());
  });

  test("local *.lndo.site URLs need --qr and stay text-only on share", () => {
    expect(renderShareResult(session({ publicUrl: LOCAL_URL }), "text", ctx())).toBe(tunnelLine(LOCAL_URL));
  });
});
