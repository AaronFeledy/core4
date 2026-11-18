import { describe, expect, test } from "bun:test";

import {
  CADDY_CONFIG_PATH,
  caddyLauncherCommand,
  caddyfileString,
  renderCaddyfile,
} from "../src/services/caddy-config.ts";
import { LANDO_ERROR_PAGE_DIR } from "../src/services/http-errors.ts";

const configFor = (input: { readonly port?: number; readonly docRoot?: string } = {}): string =>
  renderCaddyfile({ port: input.port ?? 80, docRoot: input.docRoot ?? "/app" });

const expectThrows = (run: () => unknown, pattern: RegExp): void => {
  let message = "";
  try {
    run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(pattern);
};

describe("generated Caddyfile", () => {
  test("turns off automatic HTTPS and the admin API globally", () => {
    const config = configFor();

    expect(config).toStartWith("{\n\tadmin off\n\tauto_https off\n}\n");
    expect(config).not.toContain("localhost");
    expect(config).not.toContain("https://");
  });

  test("serves the planned plain HTTP site on the planned port", () => {
    const config = configFor({ port: 8080, docRoot: "/app/dist" });

    expect(config).toContain("http://:8080 {");
    expect(config).not.toContain("http://:80 {");
    expect(config).toContain('\troot * "/app/dist"');
  });

  test("bakes the planned port even when it is the HTTPS default", () => {
    const config = configFor({ port: 443 });

    expect(config).toContain("http://:443 {");
    expect(config).toContain("auto_https off");
  });

  test("denies hidden paths while exempting only the exact .well-known segment", () => {
    const config = configFor();

    expect(config).toContain(
      ["\t@hidden {", "\t\tpath */.*", "\t\tnot path */.well-known/* */.well-known", "\t}"].join("\n"),
    );
    expect(config).toContain(
      [
        "\t@hiddenInWellKnown {",
        "\t\tpath */.well-known/* */.well-known",
        "\t\texpression `{path}.split('/').exists(segment, segment.startsWith('.') && segment != '.well-known')`",
        "\t}",
      ].join("\n"),
    );
    expect(config).toContain("\terror @hidden 403\n");
    expect(config).toContain("\terror @hiddenInWellKnown 403\n");
    // `respond` would bypass handle_errors and lose the shared page.
    expect(config).not.toContain("respond @hidden");
    expect(config).not.toContain("respond @hiddenInWellKnown");
  });

  test("routes only 403 and 404 to the shared Lando pages and keeps the status", () => {
    const config = configFor();

    expect(config).toContain(
      [
        "\thandle_errors {",
        "\t\t@landoError expression `{err.status_code} in [403, 404]`",
        "\t\thandle @landoError {",
        `\t\t\troot * "${LANDO_ERROR_PAGE_DIR}"`,
        "\t\t\trewrite * /{err.status_code}.html",
        "\t\t\tfile_server",
        "\t\t}",
        "\t}",
      ].join("\n"),
    );
    expect(config).not.toContain("[403, 404, 500]");
    expect(config).not.toContain("respond");
  });

  test("serves the document root after the hidden-path errors", () => {
    const config = configFor();

    expect(config.trimEnd().endsWith("\tfile_server\n}")).toBe(true);
    expect(config.indexOf('\troot * "/app"')).toBeLessThan(config.indexOf("\terror @hidden 403"));
    expect(config.indexOf("\terror @hidden 403")).toBeLessThan(config.lastIndexOf("\tfile_server"));
    expect(config.split("\n").filter((line) => line.trim() === "file_server")).toHaveLength(2);
  });

  test("quotes the document root and neutralizes placeholder braces", () => {
    expect(caddyfileString("/app/my site")).toBe('"/app/my site"');
    expect(caddyfileString('/app/we"ird')).toBe('"/app/we\\"ird"');
    expect(caddyfileString("/app/{env.HOME}")).toBe('"/app/\\{env.HOME\\}"');
    expect(caddyfileString("/app/root}")).toBe('"/app/root\\}"');
  });

  test.each(["/app/bad\rroot", "/app/bad\nroot", "/app/bad\u0000root"])(
    "rejects a line break or NUL in %j",
    (docRoot) => {
      expectThrows(() => configFor({ docRoot }), /cannot contain a line break or NUL/u);
    },
  );

  test("rejects a backslash it cannot quote safely", () => {
    expectThrows(() => configFor({ docRoot: "/app\\root" }), /cannot contain a backslash/u);
  });

  test.each([0, 65536, 1.5])("rejects the invalid port %p", (port) => {
    expectThrows(() => configFor({ port }), /port must be an integer from 1 to 65535/u);
  });

  test("runs the baked configuration through the caddyfile adapter", () => {
    expect(caddyLauncherCommand()).toEqual([
      "caddy",
      "run",
      "--config",
      CADDY_CONFIG_PATH,
      "--adapter",
      "caddyfile",
    ]);
  });
});
