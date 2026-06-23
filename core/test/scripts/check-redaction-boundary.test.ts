import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkRedactionBoundary } from "../../../scripts/check-redaction-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-redaction-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("redaction boundary lint gate", () => {
  test("passes for delegated redaction, keyword mentions, and test fixtures", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/x/delegating.ts",
        'import { createRedactor } from "@lando/sdk/secrets"; const r = createRedactor("secrets"); export const redactString = (v: string) => r.redactString(v);\n',
      );
      await write(
        root,
        "core/src/x/keyword-mention.ts",
        'const msg = "enter your password or token"; const url = /https?:\\/\\/[^\\s]+\\/token\\//u;\n',
      );
      await write(root, "core/src/x/redaction.test.ts", 'const value = "[redacted]";\n');

      expect(await checkRedactionBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports redaction sentinels and ad-hoc secret regex literals", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/x/sentinel-lower.ts", 'const S = "[redacted]";\n');
      await write(root, "core/src/x/sentinel-upper.ts", 'const S = "[REDACTED]";\n');
      await write(root, "plugins/y/src/regex-bearer.ts", "const R = /\\bBearer\\s+\\S+/gi;\n");
      await write(
        root,
        "plugins/y/src/regex-multikey.ts",
        "const R = /\\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z_]*)=([^\\s]+)/gu;\n",
      );
      await write(root, "core/src/x/regex-userinfo.ts", "const R = /\\/\\/([^@\\s/:]+):([^@\\s/:]+)@/gu;\n");

      const result = await checkRedactionBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/x/regex-userinfo.ts:1:/\\/\\/([^@\\s/:]+):([^@\\s/:]+)@/gu",
        "core/src/x/sentinel-lower.ts:1:[redacted]",
        "core/src/x/sentinel-upper.ts:1:[REDACTED]",
        "plugins/y/src/regex-bearer.ts:1:/\\bBearer\\s+\\S+/gi",
        "plugins/y/src/regex-multikey.ts:1:/\\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z_]*)=([^\\s]+)/gu",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
