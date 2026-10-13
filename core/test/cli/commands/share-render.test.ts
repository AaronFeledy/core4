import { describe, expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { AppId, GlobalConfig, ServiceName, type TunnelSession } from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";

import { renderShareResult } from "../../../src/cli/commands/share.ts";
import { makeEventCommandExecutor } from "../../../src/cli/event-command-executor.ts";
import { type RenderContext, runWithRendererHandling } from "../../../src/cli/renderer-boundary.ts";
import type { LandoCommandSpec } from "../../../src/cli/spec/command-base.ts";
import { renderTerminalQr } from "../../../src/cli/terminal-qr.ts";
import { makeTestRuntime } from "../../../src/testing/test-runtime.ts";

const PUBLIC_URL = "https://share.example.test";
const LOCAL_URL = "https://web.myapp.lndo.site";
const LOCALHOST_URL = "http://localhost:8080";
const IPV6_LOOPBACK_URL = "http://[::1]:8080";

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

const qrFor = (url: string): string => {
  const qr = renderTerminalQr(url);
  expect(qr).toBeDefined();
  return qr ?? "";
};

describe("renderShareResult", () => {
  test("suppresses automatic QR for the configured domain in nested command rendering", async () => {
    // Given
    const url = "https://web.dev.example.test";
    const runtime = makeTestRuntime({
      config: Schema.decodeUnknownSync(GlobalConfig)({ proxy: { defaultDomain: "dev.example.test" } }),
    });
    const output: string[] = [];
    const spec: LandoCommandSpec = {
      id: "meta:test:share-render",
      summary: "Share rendering fixture",
      namespace: "meta",
      bootstrap: "none",
      resultSchema: Schema.Unknown,
      run: () => Effect.succeed(session({ publicUrl: url })),
      render: (_value, _input, context) => renderShareResult(session({ publicUrl: url }), "text", context),
    };
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const services = yield* Effect.context<Renderer>();
        const context = Context.merge(
          Context.make(Context.Service<unknown>("test/share-runtime"), {}),
          services,
        );
        const interactiveContext = Context.add(
          context,
          Renderer,
          Renderer.of({
            ...renderer,
            capabilities: { ...renderer.capabilities, interactive: true },
            output: {
              ...renderer.output,
              stdout: (text) =>
                Effect.sync(() => {
                  output.push(text);
                }),
            },
          }),
        );
        const executor = makeEventCommandExecutor(interactiveContext, [
          { spec, status: { kind: "implemented" } },
        ]);
        yield* executor.run({ command: spec.id, flags: {}, args: {}, argv: [], cwd: "/test-runtime" });
      }).pipe(Effect.provide(runtime.layer)),
    );
    // Then
    expect(output.join("").trimEnd()).toBe(tunnelLine(url).trimEnd());
  });
  for (const url of [
    "https://dev.example.test",
    "https://WEB.DEV.EXAMPLE.TEST./",
    LOCAL_URL,
    LOCALHOST_URL,
    IPV6_LOOPBACK_URL,
  ]) {
    test(`suppresses automatic QR for ${url} with a custom domain`, () => {
      // Given
      const context = ctx({ proxyDefaultDomain: "Dev.Example.Test." });
      // When
      const output = renderShareResult(session({ publicUrl: url }), "text", context);
      // Then
      expect(output).toBe(tunnelLine(url));
    });
  }
  for (const url of [PUBLIC_URL, "https://notdev.example.test", "https://dev.example.test.public.test"]) {
    test(`preserves automatic public QR for ${url} with a custom domain`, () => {
      // Given
      const context = ctx({ proxyDefaultDomain: "dev.example.test" });
      // When
      const output = renderShareResult(session({ publicUrl: url }), "text", context);
      // Then
      expect(output).toContain(qrFor(url).trimEnd());
    });
  }
  test("suppresses automatic QR for the domain loaded by the renderer runtime", async () => {
    // Given
    const url = "https://web.dev.example.test";
    const runtime = makeTestRuntime({
      config: Schema.decodeUnknownSync(GlobalConfig)({ proxy: { defaultDomain: "  Dev.Example.Test...  " } }),
    });
    const io = createBufferedRendererIO({ isTTY: true });
    // When
    await runWithRendererHandling(Effect.succeed(session({ publicUrl: url })), {
      runtime: runtime.layer,
      rendererMode: "lando",
      io,
      render: (value, context) => renderShareResult(value, "text", context),
      formatError: () => "unexpected failure",
      setExitCode: () => undefined,
    });
    // Then
    expect(io.stdout().trimEnd()).toBe(tunnelLine(url).trimEnd());
    expect(io.stderr()).toBe("");
  });
  test("text TTY with a public URL prints the tunnel line plus a QR", () => {
    const output = renderShareResult(session(), "text", ctx());
    expect(output.startsWith(tunnelLine(PUBLIC_URL))).toBe(true);
    expect(output).toContain(qrFor(PUBLIC_URL).trimEnd());
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

  test("loopback-by-name publicUrl stays text-only on share", () => {
    expect(renderShareResult(session({ publicUrl: LOCALHOST_URL }), "text", ctx())).toBe(
      tunnelLine(LOCALHOST_URL),
    );
    expect(renderShareResult(session({ publicUrl: IPV6_LOOPBACK_URL }), "text", ctx())).toBe(
      tunnelLine(IPV6_LOOPBACK_URL),
    );
  });
});
