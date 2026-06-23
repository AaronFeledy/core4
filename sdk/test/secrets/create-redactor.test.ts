import { describe, expect, test } from "bun:test";

import { PATTERN_CLASSES, REDACTED, REDACTION_PROFILES, createRedactor } from "@lando/sdk/secrets";

describe("createRedactor surface", () => {
  test("REDACTED is the canonical [redacted] sentinel", () => {
    expect(REDACTED).toBe("[redacted]");
  });

  test("REDACTION_PROFILES lists the three published profiles", () => {
    expect(REDACTION_PROFILES).toEqual(["secrets", "telemetry", "transcript"]);
  });

  test("PATTERN_CLASSES exposes the canonical secrets catalog classes", () => {
    expect(PATTERN_CLASSES.secretAssignment).toBeDefined();
    expect(PATTERN_CLASSES.urlUserinfo).toBeDefined();
    expect(PATTERN_CLASSES.bearerToken).toBeDefined();
    expect(PATTERN_CLASSES.signedQueryParam).toBeDefined();
    expect(PATTERN_CLASSES.secretKeyedField).toBeDefined();
    expect(PATTERN_CLASSES.uncPath).toBeDefined();
    expect(PATTERN_CLASSES.homeAlias).toBeDefined();
    expect(PATTERN_CLASSES.highEntropyToken).toBeDefined();
    expect(PATTERN_CLASSES.port).toBeDefined();
    expect(PATTERN_CLASSES.containerId).toBeDefined();
    expect(PATTERN_CLASSES.digest).toBeDefined();
    expect(PATTERN_CLASSES.providerId).toBeDefined();
    expect(PATTERN_CLASSES.root).toBeDefined();
    expect(PATTERN_CLASSES.secretAssignment.pattern).toBeInstanceOf(RegExp);
  });
});

describe("secrets profile (pattern layer)", () => {
  const r = createRedactor("secrets");

  test("masks env-style secret assignments (keyword embedded in an UPPER key)", () => {
    expect(r.redactString("PASSWORD=hunter2 ok")).toBe("PASSWORD=[redacted] ok");
    expect(r.redactString("TOKEN=abcd ok")).toBe("TOKEN=[redacted] ok");
    expect(r.redactString("API_KEY=abcd ok")).toBe("API_KEY=[redacted] ok");
    expect(r.redactString("MY_API_KEY=abcd1234")).toBe("MY_API_KEY=[redacted]");
    expect(r.redactString("DATABASE_PASSWORD=hunter2 ok")).toBe("DATABASE_PASSWORD=[redacted] ok");
  });

  test("masks env-style secret assignments with lower/mixed-case keys", () => {
    expect(r.redactString("token=super-secret ok")).toBe("token=[redacted] ok");
    expect(r.redactString("Api_Key=abc123 ok")).toBe("Api_Key=[redacted] ok");
    expect(r.redactString("password=hunter2 ok")).toBe("password=[redacted] ok");
    expect(r.redactString("MY_TOKEN_VALUE=x ok")).toBe("MY_TOKEN_VALUE=[redacted] ok");
  });

  test("query-param assignments stay single-marker (owned by the signed-query class)", () => {
    expect(r.redactString("?access_token=SECRETVAL")).toBe("?access_token=[redacted]");
    expect(r.redactString("&api_key=abc")).toBe("&api_key=[redacted]");
  });

  test("masks URL userinfo credentials", () => {
    expect(r.redactString("https://user:pw@proxy:3128/x")).toBe("https://[redacted]@proxy:3128/x");
  });

  test("masks Bearer tokens but keeps the scheme word", () => {
    expect(r.redactString("Authorization: Bearer xyz.tok-123")).toBe("Authorization: Bearer [redacted]");
  });

  test("masks signed query parameters by whole key component", () => {
    expect(r.redactString("https://cdn/x?access_token=SECRETVAL&z=1")).toBe(
      "https://cdn/x?access_token=[redacted]&z=1",
    );
    // A substring keyword in an innocuous param is not redacted.
    expect(r.redactString("https://cdn/x?design=blue")).toBe("https://cdn/x?design=blue");
  });

  test("leaves ordinary text untouched", () => {
    expect(r.redactString("nothing sensitive here")).toBe("nothing sensitive here");
  });
});

describe("value layer applied before pattern layer", () => {
  test("a registered secret split across a pattern boundary never survives", () => {
    const r = createRedactor("secrets", { values: ["pa:ss@wo.rd"] });
    const out = r.redactString("https://pa:ss@wo.rd/path");
    expect(out).not.toContain("pa:ss");
    expect(out).not.toContain("wo.rd");
    expect(out).toContain("[redacted]");
  });

  test("value layer masks known values inside otherwise-innocuous text", () => {
    const r = createRedactor("secrets", { values: ["topSecretValue"] });
    expect(r.redactString("the value is topSecretValue here")).toBe("the value is [redacted] here");
  });

  test("longest-first so overlapping secrets do not leak a tail", () => {
    const r = createRedactor("secrets", { values: ["secret", "secret-token"] });
    expect(r.redactString("x secret-token y")).toBe("x [redacted] y");
  });
});

describe("redactValue structure preservation", () => {
  const r = createRedactor("secrets");

  test("masks secretKeyedField keys without recursing into the value", () => {
    const v = r.redactValue({ password: "hunter2", nested: { token: "t" }, ok: "fine" }) as Record<
      string,
      unknown
    >;
    expect(v.password).toBe("[redacted]");
    expect((v.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(v.ok).toBe("fine");
  });

  test("preserves array shape and pattern-redacts string leaves", () => {
    const v = r.redactValue({ list: [1, "MY_API_KEY=zz1", true] }) as Record<string, unknown>;
    const list = v.list as unknown[];
    expect(list[0]).toBe(1);
    expect(list[1]).toBe("MY_API_KEY=[redacted]");
    expect(list[2]).toBe(true);
  });

  test("maps Error to a redacted name/message pair", () => {
    const v = r.redactValue(new Error("MY_TOKEN=abc")) as { name: string; message: string };
    expect(v).toMatchObject({ name: "Error", message: "MY_TOKEN=[redacted]" });
  });

  test("never throws on cyclic input", () => {
    const cyc: Record<string, unknown> = { password: "hunter2" };
    cyc.self = cyc;
    expect(() => r.redactValue(cyc)).not.toThrow();
    const out = r.redactValue(cyc) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });

  test("redacts shared acyclic object references as repeated structures, not [circular]", () => {
    const shared = { ok: "fine", password: "hunter2" };
    const out = r.redactValue({ a: shared, b: shared, list: [shared, shared] }) as Record<string, unknown>;
    const expected = { ok: "fine", password: "[redacted]" };
    expect(out.a).toEqual(expected);
    expect(out.b).toEqual(expected);
    expect(out.list).toEqual([expected, expected]);
    expect(JSON.stringify(out)).not.toContain("[circular]");
  });

  test("never throws on exotic objects", () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("ownKeys boom");
        },
      },
    );
    expect(() => r.redactValue(throwingProxy)).not.toThrow();
    expect(r.redactValue(throwingProxy)).toBe("[redacted]");
  });

  test("redacts throwing object properties without leaking sibling values", () => {
    const value = {
      safe: "ok",
      get unstable() {
        throw new Error("getter boom");
      },
    };
    const out = r.redactValue(value) as Record<string, unknown>;
    expect(out.safe).toBe("ok");
    expect(out.unstable).toBe("[redacted]");
  });

  test("passes through null/undefined/number/bool unchanged", () => {
    expect(r.redactValue(null)).toBe(null);
    expect(r.redactValue(undefined)).toBe(undefined);
    expect(r.redactValue(42)).toBe(42);
    expect(r.redactValue(false)).toBe(false);
  });
});

describe("telemetry profile placeholders", () => {
  const t = createRedactor("telemetry");

  test("normalizes url/path/id/email to placeholders", () => {
    expect(t.redactString("see https://api.example.com/v1 done")).toBe("see [url] done");
    expect(t.redactString("at /home/alice/app done")).toBe("at [path] done");
    expect(t.redactString("id 12345678-1234-1234-1234-123456789abc done")).toBe("id [id] done");
    expect(t.redactString("mail alice@example.co done")).toBe("mail [email] done");
  });

  test("collapses a bare hostname to [host] after urls/emails removed", () => {
    expect(t.redactString("host api.example.com here")).toBe("host [host] here");
  });

  test("redacts a high-entropy token only when it has a letter and a digit", () => {
    expect(t.redactString("tok abcd1234efgh5678ijkl9012mnop done")).toBe("tok [redacted] done");
    // all-letters long run is not a token
    expect(t.redactString("word abcdefghijklmnopqrstuvwxyzabc done")).toBe(
      "word abcdefghijklmnopqrstuvwxyzabc done",
    );
  });

  test("applies secrets-profile string passes (signed query params, URL userinfo)", () => {
    expect(t.redactString("https://cdn/x?access_token=SECRETVAL&z=1")).toBe("[url]");
    expect(t.redactString("?access_token=SECRETVAL")).toBe("?access_token=[redacted]");
    expect(t.redactString("https://user:pw@proxy:3128/x")).toBe("[url]");
  });
});

describe("transcript profile placeholders", () => {
  test("masks env home root to <HOME> when env supplied", () => {
    const tr = createRedactor("transcript", { env: { home: "/home/alice" } });
    expect(tr.redactString("/home/alice/app")).toContain("<HOME>");
  });

  test("masks ephemeral ports to <PORT> but keeps well-known ports", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("listening on :54321")).toContain("<PORT>");
    expect(tr.redactString("https on :443")).toContain(":443");
  });

  test("masks container ids and sha256 digests", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("container abc123def456")).toContain("<CONTAINER_ID>");
    expect(tr.redactString(`image sha256:${"a".repeat(64)}`)).toContain("sha256:<DIGEST>");
  });

  test("masks provider-style ids to <PROVIDER_ID>", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("svc myapp_web_main")).toContain("<PROVIDER_ID>");
  });

  test("masks generic path roots with no env supplied", () => {
    const tr = createRedactor("transcript");
    expect(tr.redactString("/Users/bob/x")).toContain("<HOME>");
  });

  test("masks env user and host literals when supplied", () => {
    const tr = createRedactor("transcript", { env: { user: "alice", host: "devbox" } });
    expect(tr.redactString("user alice on devbox")).toBe("user <USER> on <HOST>");
  });
});
