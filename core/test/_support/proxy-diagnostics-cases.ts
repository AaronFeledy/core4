export interface DiagnosticRequest {
  readonly scheme: "http" | "https";
  readonly method: "GET" | "HEAD" | "POST";
  readonly host: string;
  readonly path: string;
  readonly accept?: string;
}

/** `html` is the diagnostic page; `plain` is the exact Traefik-style text 404. */
export type DiagnosticOutcome = "html" | "plain";

export interface DiagnosticCase {
  readonly name: string;
  readonly request: DiagnosticRequest;
  readonly expected: DiagnosticOutcome;
}

export const UNMATCHED_HOST = "nothing.lndo.site";

const unmatched = (
  name: string,
  expected: DiagnosticOutcome,
  request: Partial<DiagnosticRequest> = {},
): DiagnosticCase => ({
  name,
  expected,
  request: { scheme: "http", method: "GET", host: UNMATCHED_HOST, path: "/some/path?x=1", ...request },
});

// One request per negotiation clause. The quoted-parameter forms are the ones a
// plain comma or semicolon split misreads, so they run against the real nginx
// map rather than only the unit-level regex model.
export const proxyDiagnosticCases: ReadonlyArray<DiagnosticCase> = [
  unmatched("unmatched HTTP request without an HTML preference is a plain 404", "plain"),
  unmatched("unmatched HTTPS request without an HTML preference is a plain 404", "plain", {
    scheme: "https",
  }),
  unmatched("unmatched HTTP request accepting text/html gets the HTML page", "html", { accept: "text/html" }),
  unmatched("unmatched HTTPS request accepting text/html gets the HTML page", "html", {
    scheme: "https",
    accept: "text/html",
  }),
  unmatched("browser-style Accept list gets the HTML page", "html", {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  }),
  unmatched("text/html with a positive weight after other ranges gets the HTML page", "html", {
    accept: "application/json, text/html;q=0.8",
  }),
  unmatched("case-insensitive media range and parameters get the HTML page", "html", {
    accept: "TEXT/HTML;LEVEL=1;Q=0.5",
  }),
  unmatched("text/html;q=0 stays plain", "plain", { accept: "text/html;q=0" }),
  unmatched("text/html;q=0.000 with trailing ranges stays plain", "plain", {
    accept: "text/html;level=1;q=0.000, application/json",
  }),
  unmatched("wildcard and JSON ranges stay plain", "plain", { accept: "application/json, */*;q=0.8" }),
  unmatched("text/html;q=0 beside a wildcard stays plain", "plain", { accept: "text/html;q=0,*/*;q=0.8" }),
  unmatched("a quoted comma does not end the text/html range before q=0", "plain", {
    accept: 'text/html;profile="a,b";q=0',
  }),
  unmatched("a quoted comma keeps a positive text/html weight", "html", {
    accept: 'text/html;profile="a,b";q=0.5',
  }),
  unmatched("a quoted semicolon never starts a q=0 weight", "html", {
    accept: 'text/html;profile="x;q=0;";q=1',
  }),
  unmatched("escaped quotes stay inside the quoted parameter", "plain", {
    accept: 'text/html;title="say \\"hi\\",ok";q=0',
  }),
  unmatched("text/html quoted inside another range is not an HTML preference", "plain", {
    accept: 'application/json;x="a,text/html;b", */*',
  }),
  unmatched("HEAD accepting text/html gets HTML headers without a body", "html", {
    method: "HEAD",
    accept: "text/html",
  }),
  unmatched("HEAD without an HTML preference stays plain", "plain", { method: "HEAD" }),
  unmatched("POST accepting text/html stays plain", "plain", { method: "POST", accept: "text/html" }),
  unmatched("POST without an HTML preference stays plain", "plain", { method: "POST" }),
];
