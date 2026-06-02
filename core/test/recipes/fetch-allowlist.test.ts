import { describe, expect, test } from "bun:test";

import { RecipeFetchNotAllowedError } from "@lando/sdk/errors";

import {
  DEFAULT_FETCH_ALLOWLIST,
  createRecipeFetchContext,
  defaultFetchWarning,
  evaluateFetchPermission,
  fetchNotAllowedError,
  matchesUrlGlob,
} from "../../src/recipes/fetch-allowlist.ts";

const redirectResponse = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

describe("recipe fetch allowlist — glob matching", () => {
  test("** matches across path segments", () => {
    expect(matchesUrlGlob("https://api.example.com/**", "https://api.example.com/v1/data")).toBe(true);
    expect(matchesUrlGlob("https://api.example.com/**", "https://api.example.com/")).toBe(true);
  });

  test("* matches within a single segment but not across slashes", () => {
    expect(
      matchesUrlGlob("https://registry.lando.dev/recipes/*", "https://registry.lando.dev/recipes/drupal"),
    ).toBe(true);
    expect(
      matchesUrlGlob(
        "https://registry.lando.dev/recipes/*",
        "https://registry.lando.dev/recipes/drupal/extra",
      ),
    ).toBe(false);
  });

  test("a non-matching host is rejected", () => {
    expect(matchesUrlGlob("https://api.example.com/**", "https://evil.example.com/v1")).toBe(false);
  });

  test("exact globs match exactly", () => {
    expect(matchesUrlGlob("https://api.example.com/health", "https://api.example.com/health")).toBe(true);
    expect(matchesUrlGlob("https://api.example.com/health", "https://api.example.com/health/x")).toBe(false);
  });
});

describe("recipe fetch allowlist — permission evaluation", () => {
  test("explicit allowlist permits a matching URL", () => {
    expect(evaluateFetchPermission(["https://api.example.com/**"], "https://api.example.com/v1")).toEqual({
      kind: "allowed",
    });
  });

  test("explicit allowlist denies a non-matching URL", () => {
    expect(evaluateFetchPermission(["https://api.example.com/**"], "https://evil.example.com/x")).toEqual({
      kind: "denied",
      allowlist: ["https://api.example.com/**"],
    });
  });

  test("undefined allowlist falls back to a permissive warn", () => {
    expect(evaluateFetchPermission(undefined, "https://anywhere.example.com/x")).toEqual({
      kind: "warn",
      allowlist: DEFAULT_FETCH_ALLOWLIST,
    });
  });

  test("fetchNotAllowedError builds the tagged payload", () => {
    const error = fetchNotAllowedError("https://evil.example.com/x", ["https://api.example.com/**"], {
      recipe: "fixture",
      viaRedirect: true,
    });
    expect(error).toBeInstanceOf(RecipeFetchNotAllowedError);
    expect(error.url).toBe("https://evil.example.com/x");
    expect(error.allowlist).toEqual(["https://api.example.com/**"]);
    expect(error.recipe).toBe("fixture");
    expect(error.viaRedirect).toBe(true);
    expect(error.remediation).toContain("fetchAllowlist");
  });

  test("defaultFetchWarning names the URL", () => {
    expect(defaultFetchWarning("https://anywhere.example.com/x", DEFAULT_FETCH_ALLOWLIST)).toContain(
      "https://anywhere.example.com/x",
    );
  });
});

describe("recipe fetch allowlist — ctx.fetch", () => {
  test("an allowed URL is fetched through the platform fetch", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      calls.push(url.toString());
      return new Response("ok", { status: 200 });
    };
    const ctx = createRecipeFetchContext({
      allowlist: ["https://api.example.com/**"],
      fetchImpl: fetchImpl as typeof fetch,
      recipe: "fixture",
    });

    const response = await ctx.fetch("https://api.example.com/v1/data");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(calls).toEqual(["https://api.example.com/v1/data"]);
  });

  test("a denied URL throws before the platform fetch is invoked", async () => {
    let invoked = 0;
    const fetchImpl = async () => {
      invoked += 1;
      return new Response("ok", { status: 200 });
    };
    const ctx = createRecipeFetchContext({
      allowlist: ["https://api.example.com/**"],
      fetchImpl: fetchImpl as typeof fetch,
      recipe: "fixture",
    });

    let caught: unknown;
    try {
      await ctx.fetch("https://evil.example.com/steal");
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(RecipeFetchNotAllowedError);
    if (caught instanceof RecipeFetchNotAllowedError) {
      expect(caught.url).toBe("https://evil.example.com/steal");
      expect(caught.allowlist).toEqual(["https://api.example.com/**"]);
      expect(caught.recipe).toBe("fixture");
      expect(caught.viaRedirect).toBeUndefined();
    }
    expect(invoked).toBe(0);
  });

  test("a redirect to an allowed target is followed", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const target = url.toString();
      calls.push(target);
      if (target === "https://api.example.com/old") return redirectResponse("https://api.example.com/new");
      return new Response("final", { status: 200 });
    };
    const ctx = createRecipeFetchContext({
      allowlist: ["https://api.example.com/**"],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const response = await ctx.fetch("https://api.example.com/old");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("final");
    expect(calls).toEqual(["https://api.example.com/old", "https://api.example.com/new"]);
  });

  test("a redirect to an out-of-allowlist target throws viaRedirect", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const target = url.toString();
      calls.push(target);
      if (target === "https://api.example.com/old")
        return redirectResponse("https://evil.example.com/gotcha");
      return new Response("should-not-reach", { status: 200 });
    };
    const ctx = createRecipeFetchContext({
      allowlist: ["https://api.example.com/**"],
      fetchImpl: fetchImpl as typeof fetch,
      recipe: "fixture",
    });

    let caught: unknown;
    try {
      await ctx.fetch("https://api.example.com/old");
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(RecipeFetchNotAllowedError);
    if (caught instanceof RecipeFetchNotAllowedError) {
      expect(caught.url).toBe("https://evil.example.com/gotcha");
      expect(caught.viaRedirect).toBe(true);
    }
    expect(calls).toEqual(["https://api.example.com/old"]);
  });

  test("relative redirect Location is resolved against the current URL", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const target = url.toString();
      calls.push(target);
      if (target === "https://api.example.com/a/old") return redirectResponse("/a/new");
      return new Response("final", { status: 200 });
    };
    const ctx = createRecipeFetchContext({
      allowlist: ["https://api.example.com/**"],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const response = await ctx.fetch("https://api.example.com/a/old");
    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://api.example.com/a/old", "https://api.example.com/a/new"]);
  });

  test("undefined allowlist warns once per fetched URL and proceeds", async () => {
    const warnings: string[] = [];
    const fetchImpl = async () => new Response("ok", { status: 200 });
    const ctx = createRecipeFetchContext({
      allowlist: undefined,
      fetchImpl: fetchImpl as typeof fetch,
      onWarn: (msg) => warnings.push(msg),
    });

    const response = await ctx.fetch("https://anywhere.example.com/x");
    expect(response.status).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("https://anywhere.example.com/x");
  });

  test("a redirect loop is bounded and surfaces a clear error", async () => {
    const fetchImpl = async (url: string | URL) => redirectResponse(url.toString());
    const ctx = createRecipeFetchContext({
      allowlist: ["https://api.example.com/**"],
      fetchImpl: fetchImpl as typeof fetch,
      maxRedirects: 3,
    });

    let caught: unknown;
    try {
      await ctx.fetch("https://api.example.com/loop");
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("redirect");
  });
});
