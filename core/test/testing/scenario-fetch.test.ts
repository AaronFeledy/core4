import { expect, test } from "bun:test";
import { makeMintingCertificateAuthority } from "@lando/sdk/test";
import { Effect, Redacted } from "effect";
import {
  ScenarioFetchError,
  requestScenarioRoute,
  resolveFetchUrl,
} from "../../src/testing/scenario-fetch.ts";

test("a route token uses the assigned host route rather than the app listener", async () => {
  const info = Effect.promise(() =>
    Bun.file(new URL("./fixtures/scenario-fetch-info.json", import.meta.url)).text(),
  );
  const resolved = await Effect.runPromise(resolveFetchUrl("{{route:app}}/https-check.php?probe=1", info));
  expect(resolved.href).toBe("https://app.php-demo.lndo.site:38443/https-check.php?probe=1");
  expect(
    await Effect.runPromise(Effect.flip(resolveFetchUrl("{{route:no-such-service}}/", info))),
  ).toBeInstanceOf(ScenarioFetchError);
});

test("a pinned TLS request preserves the URL identity and does not follow a redirect", async () => {
  const hostname = "guide-fetch.invalid";
  const ca = makeMintingCertificateAuthority();
  const leaf = await Effect.runPromise(ca.issueCert({ cn: hostname, sans: [hostname] }));
  const requests: string[] = [];
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { serverName: hostname, cert: leaf.certificate, key: Redacted.value(leaf.privateKey) },
    fetch(request) {
      requests.push(`${request.method} ${request.headers.get("host")} ${new URL(request.url).pathname}`);
      return new Response(request.headers.get("x-test"), { status: 302, headers: { Location: "/next" } });
    },
  });
  const url = new URL(`https://${hostname}:${server.port}/check`);
  const pem = leaf.root.certificate;
  const result = await Effect.runPromise(
    requestScenarioRoute(url, { headers: { "X-Test": "via-router" } }, pem),
  );
  const head = await Effect.runPromise(requestScenarioRoute(url, { method: "HEAD" }, pem));
  const wrongCa = await Effect.runPromise(makeMintingCertificateAuthority().root);
  const untrusted = await Effect.runPromise(Effect.flip(requestScenarioRoute(url, {}, wrongCa.certificate)));
  const wrongHost = new URL(`https://other.invalid:${server.port}/check`);
  const wrongIdentity = await Effect.runPromise(Effect.flip(requestScenarioRoute(wrongHost, {}, pem)));
  const missingCa = await Effect.runPromise(Effect.flip(requestScenarioRoute(url, {}, undefined)));

  expect(result.status).toBe(302);
  expect(result.headers.location).toBe("/next");
  expect(result.body).toBe("via-router");
  expect(head.status).toBe(302);
  expect(head.body).toBe("");
  expect(untrusted).toBeInstanceOf(ScenarioFetchError);
  expect(wrongIdentity).toBeInstanceOf(ScenarioFetchError);
  expect(missingCa).toBeInstanceOf(ScenarioFetchError);
  expect(requests).toEqual([
    `GET ${hostname}:${server.port} /check`,
    `HEAD ${hostname}:${server.port} /check`,
  ]);
});
