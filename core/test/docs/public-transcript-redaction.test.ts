import { describe, expect, test } from "bun:test";

import type { PublicTranscript } from "@lando/sdk/docs/components";

import {
  type RedactionEnvironment,
  redactPublicTranscript,
  redactPublicTranscriptText,
} from "../../src/docs/render/redaction.ts";

const posixEnv: RedactionEnvironment = {
  home: "/home/aaron",
  tmp: "/tmp",
  user: "aaron",
  host: "devbox",
  extraRoots: [
    "/home/aaron/projects/experiments/lando4-rewrite2/.local/core4-agent2",
    "/tmp/lando-fixture-abc123",
  ],
};

const windowsEnv: RedactionEnvironment = {
  home: "C:\\Users\\aaron",
  tmp: "C:\\Users\\aaron\\AppData\\Local\\Temp",
  user: "aaron",
  host: "WINDEV",
  extraRoots: [
    "C:\\Users\\aaron\\projects\\experiments\\lando4-rewrite2\\.local\\core4-agent2",
    "C:\\Users\\aaron\\AppData\\Local\\Temp\\lando-fixture-abc123",
  ],
};

describe("public transcript redaction (US-249)", () => {
  test("redacts POSIX temp dirs, home, app roots, fixture roots, usernames, hostnames, random ports, container ids, provider ids, and secrets", () => {
    const input =
      "started in /home/aaron/projects/myapp with tmp /tmp/lando-abc123 fixture /tmp/lando-fixture-abc123 on host devbox user aaron port :54321 container a1b2c3d4e5f6 provider myapp_web_ab12cd34 token=secret123 ACCESS_TOKEN='quoted-env-token' --token=\"quoted-token\" --password 'quoted-password' --api-key='quoted-api-key' ?X-Amz-Signature=deadbeef";

    const out = redactPublicTranscriptText(input, posixEnv);

    expect(out).not.toContain("/home/aaron");
    expect(out).not.toContain("/tmp/lando-abc123");
    expect(out).not.toContain("/tmp/lando-fixture-abc123");
    expect(out).not.toContain("devbox");
    expect(out).not.toContain("aaron");
    expect(out).not.toContain(":54321");
    expect(out).not.toContain("a1b2c3d4e5f6");
    expect(out).not.toContain("myapp_web_ab12cd34");
    expect(out).not.toContain("secret123");
    expect(out).not.toContain("quoted-env-token");
    expect(out).not.toContain("quoted-token");
    expect(out).not.toContain("quoted-password");
    expect(out).not.toContain("quoted-api-key");
    expect(out).not.toContain("deadbeef");

    expect(out).toContain("<HOME>");
    expect(out).toContain("<TMP>");
    expect(out).toContain("<USER>");
    expect(out).toContain("<HOST>");
    expect(out).toContain("<PORT>");
    expect(out).toContain("<CONTAINER_ID>");
    expect(out).toContain("<PROVIDER_ID>");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts Windows paths, %USERPROFILE%, %TEMP%, and equivalent secrets", () => {
    const input =
      "path C:\\Users\\aaron\\projects\\myapp %USERPROFILE%\\AppData\\Local\\Temp\\lando-xyz :49152 container deadbeef1234 proj_web_1 ?token=secret";

    const out = redactPublicTranscriptText(input, windowsEnv);

    expect(out).not.toContain("C:\\Users\\aaron");
    expect(out).not.toContain("%USERPROFILE%");
    expect(out).not.toContain("%TEMP%");
    expect(out).not.toContain("deadbeef1234");
    expect(out).not.toContain("proj_web_1");
    expect(out).not.toContain("secret");

    expect(out).toContain("<HOME>");
    expect(out).toContain("<TMP>");
    expect(out).toContain("<PORT>");
    expect(out).toContain("<CONTAINER_ID>");
    expect(out).toContain("<PROVIDER_ID>");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts provider-specific ids and sha256 digests conservatively", () => {
    const input =
      "container myapp_web_1 and sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef and random 12hex aabbccddeeff";

    const out = redactPublicTranscriptText(input, posixEnv);

    expect(out).toContain("<PROVIDER_ID>");
    expect(out).toContain("sha256:<DIGEST>");
    expect(out).toContain("<CONTAINER_ID>");
  });

  test("redacts repo-relative fixture paths from public transcript text", () => {
    const input =
      "copy core/test/cli/fixtures/meta-doctor.provider-status.ndjson and docs/guides/mongodb/fixtures/basic/.lando.yml";

    const out = redactPublicTranscriptText(input, posixEnv);

    expect(out).not.toContain("core/test/cli/fixtures/meta-doctor.provider-status.ndjson");
    expect(out).not.toContain("docs/guides/mongodb/fixtures/basic/.lando.yml");
    expect(out).toBe("copy <HOME> and <HOME>");
  });

  test("redacts short secret flag values", () => {
    const input = "lando auth -t=token-inline -k 'quoted-key' deploy -t `backtick-token` -k spaced-key";

    const out = redactPublicTranscriptText(input, posixEnv);

    expect(out).not.toContain("token-inline");
    expect(out).not.toContain("quoted-key");
    expect(out).not.toContain("backtick-token");
    expect(out).not.toContain("spaced-key");
    expect(out).toContain("-t=[REDACTED]");
    expect(out).toContain("-k [REDACTED]");
    expect(out).toContain("-t [REDACTED]");
  });

  test("redacts library-mode displayText and commandDisplay containing paths/secrets", () => {
    const frame = {
      kind: "inline" as const,
      sourceFile: "docs/guides/embedding/library-mode.mdx",
      sourceLine: 17,
      displayText: "LandoCore from /home/aaron/lando/core with token secret",
      commandDisplay: undefined,
      resultSummary: "library call on devbox",
    };

    const tx = {
      guideId: "lib-demo",
      scenarioId: "basic",
      variant: "",
      runtime: "library",
      render: true,
      frames: [frame],
    } as unknown as PublicTranscript;

    const redacted = redactPublicTranscript(tx, posixEnv);

    const f = redacted.frames[0];
    expect(f.displayText).toContain("<HOME>");
    expect(f.displayText).toContain("[REDACTED]");
    expect(f.resultSummary).toContain("<HOST>");
    expect(f.sourceFile).toBe("docs/guides/embedding/library-mode.mdx");
    expect(f.sourceLine).toBe(17);
  });

  test("is deterministic: identical output for same logical input under POSIX vs Windows env", () => {
    const input =
      "/home/user/app C:\\Users\\user\\app /tmp/lando-123 C:\\Users\\user\\AppData\\Local\\Temp\\lando-123 :54321 a1b2c3d4e5f6 myapp_web_ab12cd34 ?token=foo sha256:deadbeef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    const p = redactPublicTranscriptText(input, posixEnv);
    const w = redactPublicTranscriptText(input, windowsEnv);

    expect(p).toBe(w);
  });

  test("is idempotent: redact(redact(x)) === redact(x)", () => {
    const input = "/home/aaron/app /tmp/lando-xyz :49152 aabbccddeeff myapp_web_1 ?token=bar";

    const once = redactPublicTranscriptText(input, posixEnv);
    const twice = redactPublicTranscriptText(once, posixEnv);

    expect(twice).toBe(once);
  });

  test("preserves structural fields and does not leak private data into PublicTranscript shape", () => {
    const leaking = {
      kind: "run" as const,
      sourceFile: "docs/guides/foo.mdx",
      sourceLine: 42,
      displayText: "run /home/aaron/lando port :54321 token=secret on devbox",
      commandDisplay: "lando start",
      resultSummary: "container deadbeef1234",
    };

    const tx = {
      guideId: "foo",
      scenarioId: "bar",
      variant: "provider=docker",
      runtime: "cli",
      render: true,
      frames: [leaking],
    } as unknown as PublicTranscript;

    const redacted = redactPublicTranscript(tx, posixEnv);

    const f = redacted.frames[0];
    expect(f.displayText).toContain("<HOME>");
    expect(f.displayText).toContain("<PORT>");
    expect(f.displayText).toContain("[REDACTED]");
    expect(f.displayText).toContain("<HOST>");
    expect(f.resultSummary).toContain("<CONTAINER_ID>");
    expect(f.sourceFile).toBe("docs/guides/foo.mdx");
    expect(f.sourceLine).toBe(42);
    expect(f.kind).toBe("run");
    expect(redacted.guideId).toBe("foo");
    expect(redacted.variant).toBe("provider=docker");

    // No raw leaks
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("/home/aaron");
    expect(json).not.toContain(":54321");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("devbox");
    expect(json).not.toContain("deadbeef1234");
  });

  test("conservative non-redaction: documented ports, prose, and non-secret hex survive", () => {
    const input =
      "service listening on :8080 and :443 step: start the app with checksum aabbccdd... (64 hex not a digest) and container id in prose";

    const out = redactPublicTranscriptText(input, posixEnv);

    expect(out).toContain(":8080");
    expect(out).toContain(":443");
    expect(out).toContain("start the app");
    expect(out).toContain("checksum aabbccdd");
  });
});
