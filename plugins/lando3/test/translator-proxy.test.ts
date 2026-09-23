import { describe, expect, test } from "bun:test";
import { validateConfigTranslateResult } from "@lando/sdk/landofile";
import { LandofileAuthoringFragment, LandofileShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Either, Schema } from "effect";
import { defaultLando3Ports, makeLando3ConfigTranslator } from "../src/translator.ts";
import { isPlainRecord, mergeLandofiles } from "../src/v4-merge.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

const translateFiles = async (files: ReadonlyArray<readonly [string, string]>) => {
  const result = await Effect.runPromise(
    makeLando3ConfigTranslator(defaultLando3Ports()).translate(
      documentSet(files.map(([path, text]) => document(path, text))),
    ),
  );
  const fragments = result.outputs.map(({ fragment }) => {
    Schema.decodeUnknownSync(LandofileAuthoringFragment)(fragment, { onExcessProperty: "error" });
    Schema.decodeUnknownSync(LandofileShape)(fragment, { onExcessProperty: "error" });
    if (!isPlainRecord(fragment)) throw new Error("Expected a mapping fragment");
    return fragment;
  });
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.sourceId.length).toBeGreaterThan(0);
    expect(diagnostic.span?.start.line).toBeGreaterThan(0);
    expect(diagnostic.message.length).toBeGreaterThan(0);
    expect(diagnostic.remediation?.length).toBeGreaterThan(0);
  }
  return { ...result, merged: mergeLandofiles(fragments) };
};
const translate = (proxy: string) => translateFiles([[".lando.yml", `name: routes\nproxy: ${proxy}\n`]]);
const route = (hostname: string, extra = {}) => ({ hostname, scheme: "both", ...extra });
const strip = (prefix: string) => ({ type: "stripPrefix", prefix });

describe("proxy lowering", () => {
  test("emits ordered objects when strings contain wildcards, ports and prefixes", async () => {
    // Given / When
    const result = await translate(
      "{appserver: [demo.lndo.site, '*-demo.lndo.site', 'a*b.demo:65535/api/', 'root.demo/'], node: ['node.demo:1']}",
    );
    // Then
    expect(result.merged.proxy).toEqual({
      appserver: [
        route("demo.lndo.site"),
        route("*-demo.lndo.site"),
        route("a*b.demo", { endpoint: 65535, pathPrefix: "/api", filters: [strip("/api")] }),
        route("root.demo"),
      ],
      node: [route("node.demo", { endpoint: 1 })],
    });
    expect(result.diagnostics.map(({ kind, keyPath }): unknown[] => [kind, keyPath])).toEqual([
      ...[0, 1, 2, 3].map((index) => ["rewritten", ["proxy", "appserver", index]]),
      ["rewritten", ["proxy", "node", 0]],
    ]);
  });

  test.each([
    [
      "{hostname: 'demo:80/old', port: '8080', pathname: '///new/'}",
      { endpoint: 8080, pathPrefix: "/new", filters: [strip("/new")] },
    ],
    ["{hostname: 'demo:80/old', port: 443, pathname: '/'}", { endpoint: 443 }],
    ["{hostname: 'demo:80/old'}", { endpoint: 80, pathPrefix: "/old", filters: [strip("/old")] }],
    ["{hostname: 'demo:invalid', port: 8080}", { endpoint: 8080 }],
  ])("normalizes object routes when authored as %s", async (input, expected) => {
    // Given / When
    const result = await translate(`{appserver: [${input}]}`);
    // Then
    expect(result.merged.proxy).toEqual({ appserver: [route("demo", expected)] });
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["rewritten"]);
  });

  test("splits HTTP and HTTPS when supported secured middleware exists", async () => {
    // Given / When
    const result = await translate(`
  appserver:
    - hostname: demo
      pathname: /api/
      middlewares:
        - {name: tls-secured, key: Headers.CustomResponseHeaders.X-TLS, value: true}
        - {name: req, key: HEADERS.CUSTOMREQUESTHEADERS.X-Count, value: 42}
        - {name: res, key: headers.customresponseheaders.X-Text, value: '{{literal}}'}
    - last.demo`);
    // Then
    const plain = [
      strip("/api"),
      { type: "requestHeader", name: "req", header: "X-Count", value: "42" },
      { type: "responseHeader", name: "res", header: "X-Text", value: "{{{{literal}}" },
    ];
    expect(result.merged.proxy).toEqual({
      appserver: [
        { hostname: "demo", scheme: "http", pathPrefix: "/api", filters: plain },
        {
          hostname: "demo",
          scheme: "https",
          pathPrefix: "/api",
          filters: [
            ...plain,
            { type: "responseHeader", name: "tls-secured", header: "X-TLS", value: "true" },
          ],
        },
        route("last.demo"),
      ],
    });
  });

  test.each([
    "{name: auth, key: basicauth.users, value: user}",
    "{name: auth, key: redirectscheme.scheme, value: https}",
    "{name: auth, key: stripprefix.prefixes, value: /api}",
    "{name: auth, key: ratelimit.average, value: 10}",
    "{name: auth, value: x}",
    "{key: headers.customrequestheaders.X-Test, value: x}",
    "{name: auth, key: headers.customrequestheaders.Bad_Header, value: x}",
    "{name: auth, key: headers.customresponseheaders.X-Test, value: {nested: x}}",
    "{name: auth-secured, key: basicauth.users, value: user}",
    "!load middleware.yml",
    "false",
  ])("drops only the middleware when it cannot lower %s", async (middleware) => {
    // Given / When
    const result = await translate(`{appserver: [{hostname: demo, middlewares: [${middleware}]}]}`);
    // Then
    expect(result.merged.proxy).toEqual({ appserver: [route("demo")] });
    const dropped = result.diagnostics.filter(({ kind }) => kind === "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.keyPath).toEqual(["proxy", "appserver", 0, "middlewares", 0]);
    if (middleware.includes("name: auth")) expect(dropped[0]?.message).toContain("auth");
    expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([]);
  });

  test.each([
    "42",
    "false",
    "null",
    "[]",
    "{}",
    "!load route.yml",
    "''",
    "'-bad.demo'",
    "'bad-.demo'",
    "'bad..demo'",
    "'bad_demo'",
    "'https://demo'",
    "'demo?x'",
    "'demo/#x'",
    "'demo/a b'",
    "'demo:0'",
    "'demo:65536'",
    "'demo:1.5'",
    "'demo:abc'",
    "'demo:'",
    "'demo:80:90'",
    "{hostname: demo, port: true}",
    "{hostname: demo, port: 2.5}",
    "{hostname: demo, port: '1e2'}",
    "{hostname: demo, pathname: false}",
    "{hostname: demo, pathname: !load path.txt}",
    "'demo/{{path}}'",
    "'demo/${PATH}'",
    "'${HOST}'",
    "'{{host}}'",
    "{hostname: demo, pathname: '${PATH}'}",
  ])("omits an unsupported route when authored as %s", async (input) => {
    // Given / When
    const result = await translate(`{appserver: [${input}, good.demo]}`);
    // Then
    expect(result.merged.proxy).toEqual({ appserver: [route("good.demo")] });
    expect(
      result.diagnostics.filter(({ kind }) => kind === "unsupported").map(({ keyPath }) => keyPath),
    ).toEqual([["proxy", "appserver", 0]]);
  });

  test.each([
    "null",
    "42",
    "[]",
    "'maybe'",
    "!load proxy.yml",
    "{appserver: demo}",
    "{appserver: !load routes.yml}",
  ])("diagnoses malformed proxy input %s", async (input) => {
    // Given / When
    const result = await translate(input);
    // Then
    expect(result.merged.proxy).toBeUndefined();
    expect(
      result.diagnostics.filter(({ kind }) => kind === "unsupported").map(({ keyPath }) => keyPath),
    ).toEqual([input.startsWith("{appserver") ? ["proxy", "appserver"] : ["proxy"]]);
  });

  test.each(["OFF", "'oFf'", "false", "ON", "'oN'", "true"])(
    "lowers router switch %s without addresses or mounts",
    async (input) => {
      // Given / When
      const result = await translate(input);
      // Then
      const disabled = /off|false/i.test(input);
      expect(result.merged).toEqual({ name: "routes", ...(disabled ? { router: { enabled: false } } : {}) });
      expect(result.diagnostics.map(({ kind, keyPath }): unknown[] => [kind, keyPath])).toEqual([
        [disabled ? "rewritten" : "dropped", ["proxy"]],
      ]);
    },
  );

  test("uses lowerText when header values contain shell expansions", async () => {
    // Given / When
    const result = await translate(
      "{appserver: [{hostname: demo, middlewares: [{name: good, key: headers.customrequestheaders.X-Good, value: '${NAME}'}, {name: bad, key: headers.customresponseheaders.X-Bad, value: '${NAME:-fallback}'}]}]}",
    );
    // Then
    expect(result.merged.proxy).toEqual({
      appserver: [
        route("demo", {
          filters: [{ type: "requestHeader", name: "good", header: "X-Good", value: "$NAME" }],
        }),
      ],
    });
    expect(
      result.diagnostics.filter(({ kind }) => kind === "unsupported").map(({ keyPath }) => keyPath),
    ).toEqual([["proxy", "appserver", 0, "middlewares", 1, "value"]]);
  });

  test("merges routes by hostname and middleware by name when higher layers override", async () => {
    // Given
    const base =
      "proxy:\n  appserver:\n    - hostname: demo:8080/api\n      middlewares:\n        - {name: change, key: headers.customrequestheaders.X-One, value: old}\n        - {name: keep, key: headers.customrequestheaders.X-Two, value: kept}\n    - stable.demo\n";
    const overlay =
      "name: routes\nproxy:\n  appserver:\n    - hostname: demo\n      port: '8080'\n      pathname: api/\n      middlewares:\n        - {name: change, key: headers.customresponseheaders.X-New, value: new}\n        - {name: append, key: headers.customrequestheaders.X-Three, value: added}\n    - stable.demo\n    - added.demo\n";
    // When
    const result = await translateFiles([
      [".lando.upstream.yml", base],
      [".lando.yml", overlay],
    ]);
    // Then
    expect(result.outputs.map(({ targetLayer }) => targetLayer)).toEqual(["upstream", "canonical"]);
    expect(result.merged.proxy).toEqual({
      appserver: [
        route("demo", {
          endpoint: 8080,
          pathPrefix: "/api",
          filters: [
            strip("/api"),
            { type: "responseHeader", name: "change", header: "X-New", value: "new" },
            { type: "requestHeader", name: "keep", header: "X-Two", value: "kept" },
            { type: "requestHeader", name: "append", header: "X-Three", value: "added" },
          ],
        }),
        route("stable.demo"),
        route("added.demo"),
      ],
    });
    expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([]);
  });

  test("merges a string route with an object route of the same host, port, and path", async () => {
    // Given a lower layer's string route and a higher layer's object route for that same identity.
    const result = await translateFiles([
      [".lando.upstream.yml", "proxy:\n  appserver:\n    - demo:8080/api\n"],
      [
        ".lando.yml",
        "name: routes\nproxy:\n  appserver:\n    - hostname: demo\n      port: 8080\n      pathname: /api\n      middlewares:\n        - {name: req, key: headers.customrequestheaders.X-One, value: on}\n",
      ],
    ]);
    // Then one route keeps the string route's prefix strip and the object route's header.
    expect(result.merged.proxy).toEqual({
      appserver: [
        route("demo", {
          endpoint: 8080,
          pathPrefix: "/api",
          filters: [strip("/api"), { type: "requestHeader", name: "req", header: "X-One", value: "on" }],
        }),
      ],
    });
  });
});

test("hoists a split secured route that a higher layer overrides and still orders diagnostics for core", async () => {
  // Given two layers where the higher one overrides a middleware on a route split by scheme.
  const lower =
    "name: routes\nproxy:\n  web:\n    - hostname: web.demo\n      middlewares:\n        - {name: test, key: headers.customrequestheaders.X-Test, value: kirk}\n        - {name: test-secured, key: headers.customrequestheaders.X-Ssl, value: 'on'}\n";
  const higher =
    "proxy:\n  web:\n    - hostname: web.demo\n      middlewares:\n        - {name: test, key: headers.customrequestheaders.X-Test, value: picard}\n";
  const input = documentSet([document(".lando.yml", lower), document(".lando.local.yml", higher)]);
  // When
  const result = await Effect.runPromise(makeLando3ConfigTranslator(defaultLando3Ports()).translate(input));
  // Then core accepts the result, including the unlocated relocation diagnostic.
  expect(Either.isRight(validateConfigTranslateResult(input, result))).toBe(true);
  expect(result.diagnostics.some(({ kind }) => kind === "needs-review")).toBe(true);
  const merged = mergeLandofiles(
    result.outputs.map(({ fragment }) => (isPlainRecord(fragment) ? fragment : {})),
  );
  expect(merged.proxy).toEqual({
    web: [
      route("web.demo", {
        scheme: "http",
        filters: [{ type: "requestHeader", name: "test", header: "X-Test", value: "picard" }],
      }),
      route("web.demo", {
        scheme: "https",
        filters: [
          { type: "requestHeader", name: "test", header: "X-Test", value: "picard" },
          { type: "requestHeader", name: "test-secured", header: "X-Ssl", value: "on" },
        ],
      }),
    ],
  });
});

test("declares the HTTP endpoints a route targets on services without catalog endpoints", async () => {
  // Given Lando 3 routes to a Compose service's container ports, which Lando 3 treated as HTTP.
  const result = await translateFiles([
    [
      ".lando.yml",
      "name: routes\nservices:\n  who: {type: compose, services: {image: 'traefik/whoami:v1.10'}}\n  node: {type: 'node:22'}\nproxy:\n  who: [who.demo, 'who.demo:8080/api']\n  node: ['node.demo:3000', 'node.demo:9229']\n",
    ],
  ]);
  // Then the Compose service gains internal HTTP endpoints on port 80 and 8080,
  // and the catalog service only gains the port its type does not already serve.
  const services = result.merged.services;
  expect(isPlainRecord(services) ? services.who : undefined).toMatchObject({
    endpoints: [
      { _tag: "internal", protocol: "http", port: 80 },
      { _tag: "internal", protocol: "http", port: 8080 },
    ],
  });
  expect(isPlainRecord(services) ? services.node : undefined).toMatchObject({
    endpoints: [{ _tag: "internal", protocol: "http", port: 9229 }],
  });
  expect(result.diagnostics.filter(({ kind }) => kind === "generated").map(({ keyPath }) => keyPath)).toEqual(
    [
      ["services", "who"],
      ["proxy", "who"],
      ["proxy", "node"],
    ],
  );
});

test("declares a routed port on the recipe service without dropping its endpoints", async () => {
  // Given a recipe service that already serves HTTP, plus a proxy port it does not.
  const fake = fakeDecomposers(false, true);
  const translateRecipe = (text: string) =>
    Effect.runPromise(
      makeLando3ConfigTranslator({
        decomposers: fake.decomposers,
        redactor: createRedactor("secrets"),
      }).translate(documentSet([document(".lando.yml", text)])),
    );
  const result = await translateRecipe(
    "name: routes\nrecipe: lamp\nproxy:\n  appserver: ['extra.demo:8080']\n",
  );
  const merged = mergeLandofiles(
    result.outputs.map(({ fragment }) => (isPlainRecord(fragment) ? fragment : {})),
  );
  const appserver = isPlainRecord(merged.services) ? merged.services.appserver : undefined;
  // Then the recipe endpoint survives and the routed port is appended.
  expect(isPlainRecord(appserver) ? appserver.endpoints : undefined).toEqual([
    { _tag: "internal", protocol: "http", port: 80 },
    { _tag: "internal", protocol: "http", port: 8080 },
  ]);
});
