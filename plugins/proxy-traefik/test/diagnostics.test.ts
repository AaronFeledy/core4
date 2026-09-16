import { describe, expect, test } from "bun:test";

import { renderTraefikDiagnosticNginxConfig } from "../src/diagnostics.ts";

// Decodes the emitted `map` regex exactly as nginx reads a double-quoted
// configuration token: the token spans `"~*` to the closing `"` before the
// value, so an unescaped quote or a bare `;` inside the regex would end the
// directive early, and only `\"` / `\\` collapse to their literal character.
const emittedAcceptMatcher = (config: string): RegExp => {
  const token = config.match(/^\s*"~\*((?:[^"\\]|\\[\\"])*)"\s+\/_lando\/404\.html;$/m)?.[1];
  if (token === undefined) throw new Error("diagnostic Accept pattern is not a single quoted nginx token");
  expect(token).toContain(String.raw`\\s`);
  expect(token).toContain(String.raw`\"`);
  return new RegExp(token.replace(/\\([\\"])/g, "$1"), "i");
};

describe("diagnostic nginx Accept negotiation", () => {
  const config = renderTraefikDiagnosticNginxConfig();

  test("selects HTML only for GET and HEAD requests that accept text/html", () => {
    const acceptsHtml = emittedAcceptMatcher(config);

    expect(acceptsHtml.test("GET:text/html")).toBe(true);
    expect(acceptsHtml.test("HEAD:text/html; charset=utf-8")).toBe(true);
    expect(acceptsHtml.test("GET:application/json, text/html;q=0.8")).toBe(true);
    expect(acceptsHtml.test("GET:TEXT/HTML;LEVEL=1;Q=0.5")).toBe(true);
    expect(acceptsHtml.test("GET:text/html;q=0")).toBe(false);
    expect(acceptsHtml.test("GET:text/html;level=1;q=0.000, application/json")).toBe(false);
    expect(acceptsHtml.test("GET:*/*")).toBe(false);
    expect(acceptsHtml.test("POST:text/html")).toBe(false);
  });

  test("treats quoted parameters as opaque when weighing text/html", () => {
    const acceptsHtml = emittedAcceptMatcher(config);

    // A comma inside a quoted parameter is not a media-range boundary, so the
    // q=0 that follows it still belongs to text/html.
    expect(acceptsHtml.test('GET:text/html;profile="a,b";q=0')).toBe(false);
    expect(acceptsHtml.test('GET:text/html;profile="a,b";q=0.5')).toBe(true);
    expect(acceptsHtml.test('GET:text/html;profile="a,b", application/json')).toBe(true);
    // A semicolon inside a quoted parameter never starts a `q=` weight.
    expect(acceptsHtml.test('GET:text/html;profile="x;q=0;";q=1')).toBe(true);
    expect(acceptsHtml.test('GET:text/html;profile="x;q=1";q=0')).toBe(false);
    // Escaped quotes stay inside the quoted string.
    expect(acceptsHtml.test('GET:text/html;title="say \\"hi\\",ok";q=0')).toBe(false);
    expect(acceptsHtml.test('GET:text/html;title="say \\"hi\\";q=0";q=0.9')).toBe(true);
    expect(acceptsHtml.test('GET:text/html;title="trailing\\\\";q=0')).toBe(false);
    // text/html quoted inside another media range's parameter is not a request for HTML.
    expect(acceptsHtml.test('GET:application/json;x="a,text/html;b", */*')).toBe(false);
    expect(acceptsHtml.test('GET:application/json;x="a,text/html;b", text/html;q=0.8')).toBe(true);
    // Wildcards never stand in for text/html, in either order.
    expect(acceptsHtml.test("GET:text/html;q=0,*/*;q=0.8")).toBe(false);
    expect(acceptsHtml.test("GET:*/*;q=0.8,text/html;q=0.9")).toBe(true);
    expect(acceptsHtml.test("GET:text/*, */*")).toBe(false);
    // An unterminated quote leaves the header ambiguous, so it keeps the plain response.
    expect(acceptsHtml.test('GET:text/html;profile="a,b')).toBe(false);
  });

  test("keeps both fallback responses exact and labelled utf-8", () => {
    expect(config).toContain('default_type "text/plain; charset=utf-8";');
    expect(config).toContain('return 404 "404 page not found\\n";');
    // mime.types maps the .txt/.html internal URIs, so only a server-level charset
    // keeps both fallback responses labelled utf-8 like Traefik's own 404.
    expect(config).toMatch(/^\s*charset utf-8;$/m);
  });
});
