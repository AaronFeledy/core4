import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { AbsolutePath, AppId, type FileSyncSessionSpec, ServiceName } from "@lando/sdk/schema";

import {
  MUTAGEN_NAME_MAX,
  isValidMutagenSessionName,
  mutagenSessionName,
  mutagenSessionNameFromParts,
  mutagenSessionRef,
} from "../src/session-name.ts";

const baseSpec = (
  overrides: Partial<{ appId: string; service: string; mountKey: string }> = {},
): FileSyncSessionSpec => {
  const appId = overrides.appId ?? "myapp";
  const service = overrides.service ?? "web";
  const mountKey = overrides.mountKey ?? "app-root";
  return {
    app: {
      kind: "user",
      id: AppId.make(appId),
      root: AbsolutePath.make("/srv/apps/myapp"),
    },
    service: ServiceName.make(service),
    mountKey,
    source: AbsolutePath.make("/srv/apps/myapp"),
    target: { _tag: "volume", name: "lando-sync-app-root", path: "/app" as never },
    mode: "two-way-safe",
    excludes: ["node_modules"],
  };
};

const sha12 = (input: string) => createHash("sha256").update(input).digest("hex").slice(0, 12);

describe("mutagen session naming", () => {
  test("formats the spec as `${appId}-${serviceId}-${mountKey}` for ASCII kebab-case input", () => {
    expect(mutagenSessionName(baseSpec())).toBe("myapp-web-app-root");
  });

  test("is deterministic — same spec yields the same name", () => {
    const spec = baseSpec({ appId: "alpha", service: "api", mountKey: "src" });
    expect(mutagenSessionName(spec)).toBe(mutagenSessionName(spec));
    expect(mutagenSessionRef(spec)).toBe(mutagenSessionRef(spec));
  });

  test("distinct specs yield distinct names", () => {
    expect(mutagenSessionName(baseSpec({ mountKey: "a" }))).not.toBe(
      mutagenSessionName(baseSpec({ mountKey: "b" })),
    );
    expect(mutagenSessionName(baseSpec({ service: "web" }))).not.toBe(
      mutagenSessionName(baseSpec({ service: "api" })),
    );
    expect(mutagenSessionName(baseSpec({ appId: "alpha" }))).not.toBe(
      mutagenSessionName(baseSpec({ appId: "bravo" })),
    );
  });

  test("emits identifiers that obey Mutagen kebab-case rules", () => {
    for (const input of [
      baseSpec(),
      baseSpec({ appId: "ALPHA", service: "API_v2", mountKey: "src/code" }),
      baseSpec({ mountKey: "Some Path With Spaces" }),
    ]) {
      const name = mutagenSessionName(input);
      expect(isValidMutagenSessionName(name)).toBe(true);
      expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
    }
  });

  test("lowercases and folds non-[a-z0-9-] runes into a single dash", () => {
    expect(mutagenSessionNameFromParts({ appId: "My App", service: "API", mountKey: "src" })).toBe(
      "my-app-api-src",
    );
    expect(mutagenSessionNameFromParts({ appId: "alpha", service: "web", mountKey: "src/lib" })).toBe(
      "alpha-web-src-lib",
    );
  });

  test(`truncates with a deterministic hash suffix when the sanitized name exceeds ${MUTAGEN_NAME_MAX} chars`, () => {
    const longMountKey = "very-long-mount-key-".repeat(10);
    const spec = baseSpec({ mountKey: longMountKey });
    const name = mutagenSessionName(spec);

    expect(name.length).toBeLessThanOrEqual(MUTAGEN_NAME_MAX);
    expect(isValidMutagenSessionName(name)).toBe(true);

    const raw = `${spec.app.id}-${spec.service}-${spec.mountKey}`;
    expect(name).toContain(sha12(raw));

    // Same long spec → same name.
    expect(mutagenSessionName(spec)).toBe(name);

    // Different long spec sharing the truncated prefix → different name
    // (because the hash suffix is derived from the full raw input).
    const otherSpec = baseSpec({ mountKey: `${longMountKey}-zzz` });
    expect(mutagenSessionName(otherSpec)).not.toBe(name);
  });

  test("falls back to `lando-<hash>` when sanitation strips the entire input", () => {
    const name = mutagenSessionNameFromParts({ appId: "🚀", service: "💧", mountKey: "✨" });
    expect(name).toMatch(/^lando-[0-9a-f]{12}$/u);
    expect(isValidMutagenSessionName(name)).toBe(true);
  });

  test("isValidMutagenSessionName rejects empty, leading-dash, and oversized identifiers", () => {
    expect(isValidMutagenSessionName("")).toBe(false);
    expect(isValidMutagenSessionName("-abc")).toBe(false);
    expect(isValidMutagenSessionName("abc-")).toBe(false);
    expect(isValidMutagenSessionName("ABC")).toBe(false);
    expect(isValidMutagenSessionName("a".repeat(MUTAGEN_NAME_MAX + 1))).toBe(false);
    expect(isValidMutagenSessionName("a")).toBe(true);
    expect(isValidMutagenSessionName("a".repeat(MUTAGEN_NAME_MAX))).toBe(true);
  });

  test("mutagenSessionRef brands the deterministic name as a FileSyncSessionRef", () => {
    const spec = baseSpec();
    const ref = mutagenSessionRef(spec);
    expect(ref).toBe(mutagenSessionName(spec) as never);
  });
});
