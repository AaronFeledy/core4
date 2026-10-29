import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeDiagnosticTail } from "../src/diagnostic-tail.ts";
import { collectUrlCredentialValues, createStandaloneRedactor } from "../src/service.ts";

for (const scheme of ["http", "postgres", "mongodb", "arbitrary"]) {
  test(`${scheme} userinfo supplies encoded and decoded authoritative credentials`, async () => {
    const raw = "p:/?#'!\n☃";
    const encoded = "p%3A%2F%3F%23%27%21%0A%E2%98%83";
    const values = collectUrlCredentialValues([`${scheme}://user%40name:${encoded}@host/database`]);
    expect(values.includes(raw)).toBe(true);
    expect(values.includes(encoded)).toBe(true);
    expect(values.includes("user@name")).toBe(true);
    expect(values.includes("user%40name")).toBe(true);
    const tail = await Effect.runPromise(makeDiagnosticTail({ authoritativeTokens: values }));
    tail.write(new TextEncoder().encode(`${raw}\n${encoded}\n`));
    const result = tail.finish() ?? "";
    expect(result.includes(raw)).toBe(false);
    expect(result.includes(encoded)).toBe(false);
  });
}

test.each(["x", "lando", "%20", "%0A", "bad%zz"])(
  "retains exact short, default, whitespace or malformed URL credential %s",
  async (credential) => {
    const values = collectUrlCredentialValues([undefined, "invalid URL", `custom://user:${credential}@host`]);
    expect(values.includes(credential)).toBe(true);
    let decoded: string = credential;
    try {
      decoded = decodeURIComponent(credential);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
    expect(values.includes(decoded)).toBe(true);
    const tail = await Effect.runPromise(makeDiagnosticTail({ authoritativeTokens: values }));
    tail.write(new TextEncoder().encode(`refused ${decoded}\n`));
    expect((tail.finish() ?? "").includes(`refused ${decoded}`)).toBe(false);
  },
);

test("proxy options retain encoded and decoded userinfo through the same policy", () => {
  const raw = "proxy-secret@host";
  const encoded = encodeURIComponent(raw);
  const redactor = createStandaloneRedactor("secrets", { proxyUrls: [`http://user:${encoded}@proxy:3128`] });
  const safe = redactor.redactString(`refused ${raw} ${encoded}`);
  expect(safe.includes(raw)).toBe(false);
  expect(safe.includes(encoded)).toBe(false);
});
