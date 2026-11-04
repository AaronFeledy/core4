import { describe, expect, test } from "bun:test";
import { createSiteUrlPolicy } from "../scripts/site-urls.mjs";

const preview = "http://127.0.0.1:4321";
const suffix = "/nested/docs/target/?query=1#anchor";

async function assertMapping(site: string | undefined, input: string, allowed: boolean) {
  const policy = createSiteUrlPolicy(site, preview);
  const url = new URL(input, preview);
  expect(await policy.linksToSkip(url.href)).toBe(!allowed);
  expect(policy.toLocalUrl(url)?.href).toBe(allowed ? `${preview}${suffix}` : undefined);
  const rewritten = policy.urlRewriteExpressions.reduce(
    (value, expression) => value.replace(expression.pattern, expression.replacement),
    url.href,
  );
  expect(rewritten).toBe(allowed ? `${preview}${suffix}` : url.href);
}

describe("configured site URL aliases", () => {
  test.each([
    [
      "https://docs.example.test",
      [
        "https://docs.example.test",
        "https://docs.example.test:443",
        "http://docs.example.test",
        "http://docs.example.test:80",
        "http://docs.example.test:443",
        "https://docs.example.test:80",
      ],
      ["https://docs.example.test:8443", "http://docs.example.test:8443"],
    ],
    [
      "https://docs.example.test:443",
      [
        "https://docs.example.test",
        "https://docs.example.test:443",
        "http://docs.example.test",
        "http://docs.example.test:80",
        "http://docs.example.test:443",
        "https://docs.example.test:80",
      ],
      ["http://docs.example.test:8443", "https://docs.example.test:8443"],
    ],
    [
      "http://docs.example.test:80",
      [
        "http://docs.example.test",
        "https://docs.example.test",
        "http://docs.example.test:80",
        "https://docs.example.test:443",
        "http://docs.example.test:443",
        "https://docs.example.test:80",
      ],
      ["http://docs.example.test:8443", "https://docs.example.test:8443"],
    ],
    [
      "https://docs.example.test:8443",
      ["https://docs.example.test:8443", "http://docs.example.test:8443"],
      [
        "https://docs.example.test",
        "http://docs.example.test",
        "https://docs.example.test:443",
        "http://docs.example.test:80",
        "https://docs.example.test:8444",
      ],
    ],
    [
      "http://docs.example.test:443",
      ["http://docs.example.test:443", "https://docs.example.test", "https://docs.example.test:443"],
      ["http://docs.example.test", "http://docs.example.test:80", "https://docs.example.test:80"],
    ],
    [
      "https://docs.example.test:80",
      ["https://docs.example.test:80", "http://docs.example.test", "http://docs.example.test:80"],
      ["https://docs.example.test", "https://docs.example.test:443", "http://docs.example.test:443"],
    ],
    [
      "https://[::1]:8443",
      ["https://[::1]:8443", "http://[::1]:8443"],
      ["https://[::1]", "http://[::1]", "http://[::1]:8444"],
    ],
  ] as const)("preserves default and explicit ports for %s", async (site, allowed, blocked) => {
    for (const origin of allowed) await assertMapping(site, `${origin}${suffix}`, true);
    for (const origin of blocked) await assertMapping(site, `${origin}${suffix}`, false);
  });

  test("resolves protocol-relative links from HTTP preview without widening the host boundary", async () => {
    await assertMapping("https://docs.example.test", `//docs.example.test${suffix}`, true);
    await assertMapping("https://docs.example.test", `//docs.example.test:443${suffix}`, true);
    await assertMapping("https://docs.example.test", `//docs.example.test:80${suffix}`, true);
    await assertMapping("https://docs.example.test:8443", `//docs.example.test:8443${suffix}`, true);
    await assertMapping("https://docs.example.test:8443", `//docs.example.test${suffix}`, false);
    for (const host of [
      "docs.example.test.evil.test",
      "sub.docs.example.test",
      "other.example.test",
      "docs.example.test:8443",
    ]) {
      await assertMapping("https://docs.example.test", `//${host}${suffix}`, false);
    }
  });

  test("uses parsed origins and strips userinfo while rewriting the configured host", async () => {
    await assertMapping(
      "https://docs.example.test",
      `http://fixture:fixture@docs.example.test${suffix}`,
      true,
    );
    await assertMapping(
      "https://docs.example.test",
      `https://docs.example.test@other.example.test${suffix}`,
      false,
    );
  });

  test("without a site permits only the exact preview origin", async () => {
    await assertMapping(undefined, `${preview}${suffix}`, true);
    await assertMapping(undefined, `http://127.0.0.1:4322${suffix}`, false);
    await assertMapping(undefined, `https://docs.example.test${suffix}`, false);
  });

  test("keeps double-slash site paths inside the preview origin", async () => {
    const policy = createSiteUrlPolicy("https://docs.example.test", preview);
    const source = new URL("https://docs.example.test//other.example.test/path#anchor");
    expect(await policy.linksToSkip(source.href)).toBe(false);
    const local = policy.toLocalUrl(source);
    expect(local?.origin).toBe(preview);
    expect(local?.pathname).toBe("//other.example.test/path");
    expect(local?.hash).toBe("#anchor");
  });
});
