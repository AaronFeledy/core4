import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { PublicTranscript } from "@lando/core/schema";
import { Schema } from "effect";

import {
  type TranscriptReadFile,
  type TranscriptRequest,
  findTranscriptFrame,
  isSafeTranscriptRequest,
  placeholderFor,
  resolveTranscript,
  transcriptPathFor,
} from "../src/lib/transcripts.ts";

const TRANSCRIPT_ROOT = resolve(import.meta.dir, "fixtures", "transcripts");
const PRESENT_REQUEST = {
  guideId: "demo",
  scenarioId: "happy-path",
  variant: "",
} satisfies TranscriptRequest;

describe("docs public transcript resolver", () => {
  test("resolves empty and multi-axis variant paths", () => {
    // Given: requests for the default scenario and a two-axis variant.
    const variantRequest = {
      guideId: "demo",
      scenarioId: "happy-path",
      variant: "php=v8-3 database=mariadb",
    } satisfies TranscriptRequest;

    // When: their public transcript paths are resolved.
    const paths = {
      default: transcriptPathFor(PRESENT_REQUEST, TRANSCRIPT_ROOT),
      variant: transcriptPathFor(variantRequest, TRANSCRIPT_ROOT),
    };

    // Then: variant values form the filename suffix in axis order.
    expect(paths).toEqual({
      default: join(TRANSCRIPT_ROOT, "demo", "happy-path.json"),
      variant: join(TRANSCRIPT_ROOT, "demo", "happy-path.php=v8-3.database=mariadb.json"),
    });
  });

  test("decodes a present transcript and exposes its frames", async () => {
    // Given: a valid public transcript fixture.
    const request = PRESENT_REQUEST;

    // When: the transcript is resolved from the fixture root.
    const result = await resolveTranscript(request, { root: TRANSCRIPT_ROOT });

    // Then: the schema-decoded transcript and component view are available.
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected a resolved transcript");
    expect(Schema.is(PublicTranscript)(result.transcript)).toBe(true);
    expect(result.view.frames).toHaveLength(2);
    expect(result.view.frames[1]).toMatchObject({
      commandDisplay: "lando start",
      kind: "run",
      resultSummary: "expected exit 0",
    });
  });

  test("returns missing when the transcript file is absent", async () => {
    // Given: a request with no fixture on disk.
    const request = {
      guideId: "demo",
      scenarioId: "absent",
      variant: "",
    } satisfies TranscriptRequest;

    // When: the absent transcript is resolved.
    const result = await resolveTranscript(request, { root: TRANSCRIPT_ROOT });

    // Then: the build-safe missing result is returned without a warning.
    expect(result).toEqual({
      kind: "missing",
      path: join(TRANSCRIPT_ROOT, "demo", "absent.json"),
      reason: "absent",
      request,
    });
  });

  test("finds a frame by kind and source location", async () => {
    // Given: a resolved transcript and the authored location of its Run frame.
    const result = await resolveTranscript(PRESENT_REQUEST, { root: TRANSCRIPT_ROOT });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected a resolved transcript");

    // When: the frame is looked up by its stable source key.
    const frame = findTranscriptFrame(result.view, {
      kind: "run",
      sourceFile: "docs/guides/demo.mdx",
      sourceLine: 11,
    });

    // Then: the matching captured frame is returned.
    expect(frame).toMatchObject({
      commandDisplay: "lando start",
      resultSummary: "expected exit 0",
    });
  });

  test("returns a warned missing result for invalid JSON", async () => {
    // Given: a transcript fixture containing malformed JSON.
    const request = {
      guideId: "corrupt",
      scenarioId: "invalid-json",
      variant: "",
    } satisfies TranscriptRequest;

    // When: the corrupt transcript is resolved.
    const result = await resolveTranscript(request, { root: TRANSCRIPT_ROOT });

    // Then: corruption becomes a warning-bearing missing result instead of an exception.
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing" || result.reason !== "invalid") {
      throw new Error("expected an invalid transcript result");
    }
    expect(result.warning).toMatchObject({
      code: "transcript.invalid-json",
      path: join(TRANSCRIPT_ROOT, "corrupt", "invalid-json.json"),
    });
  });

  test("returns a warned missing result for schema-invalid JSON", async () => {
    // Given: a valid JSON fixture that does not satisfy PublicTranscript.
    const request = {
      guideId: "corrupt",
      scenarioId: "invalid-schema",
      variant: "",
    } satisfies TranscriptRequest;

    // When: the invalid transcript is resolved.
    const result = await resolveTranscript(request, { root: TRANSCRIPT_ROOT });

    // Then: schema failure becomes a warning-bearing missing result instead of an exception.
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing" || result.reason !== "invalid") {
      throw new Error("expected an invalid transcript result");
    }
    expect(result.warning).toMatchObject({
      code: "transcript.invalid-schema",
      path: join(TRANSCRIPT_ROOT, "corrupt", "invalid-schema.json"),
    });
  });

  test("builds a placeholder from authored command text", () => {
    // Given: the static command authored in a guide component.
    const request = { commandText: "lando start" };

    // When: a missing-transcript placeholder is requested.
    const placeholder = placeholderFor(request);

    // Then: the authored command remains visible with a capture-status label.
    expect(placeholder).toEqual({
      commandText: "lando start",
      label: "No captured output yet",
    });
  });
});

describe("in-flight transcript cache", () => {
  const request = {
    guideId: "cache-probe",
    scenarioId: "lifecycle",
    variant: "",
  } satisfies TranscriptRequest;

  const minimalOk = {
    guideId: "cache-probe",
    scenarioId: "lifecycle",
    variant: "",
    runtime: "cli",
    render: true,
    frames: [
      {
        kind: "run",
        sourceFile: "docs/guides/demo.mdx",
        sourceLine: 11,
        commandDisplay: "lando start",
        resultSummary: "expected exit 0",
      },
    ],
  } as const;

  const rewrittenOk = {
    ...minimalOk,
    frames: [
      {
        ...minimalOk.frames[0],
        commandDisplay: "lando info",
        resultSummary: "rewritten",
      },
    ],
  } as const;

  test("same-path absent then created is visible on next resolve", async () => {
    // Given: an empty temp transcript root for this request path.
    const root = await mkdtemp(join(tmpdir(), "lando-transcript-cache-"));
    const filePath = transcriptPathFor(request, root);
    if (filePath === undefined) throw new Error("expected a safe transcript path");
    await mkdir(join(root, request.guideId), { recursive: true });

    try {
      // When: resolve while absent, then create the file and resolve again.
      const missing = await resolveTranscript(request, { root });
      await writeFile(filePath, `${JSON.stringify(minimalOk)}\n`, "utf8");
      const created = await resolveTranscript(request, { root });

      // Then: the permanent-cache bug would keep absent; in-flight-only sees the create.
      expect(missing).toMatchObject({ kind: "missing", reason: "absent" });
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") throw new Error("expected ok after create");
      expect(created.transcript.scenarioId).toBe("lifecycle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("same-path ok then deleted is visible on next resolve", async () => {
    // Given: a present transcript that is deleted after a successful resolve.
    const root = await mkdtemp(join(tmpdir(), "lando-transcript-cache-"));
    const filePath = transcriptPathFor(request, root);
    if (filePath === undefined) throw new Error("expected a safe transcript path");
    await mkdir(join(root, request.guideId), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(minimalOk)}\n`, "utf8");

    try {
      // When: resolve ok, delete, resolve again.
      const first = await resolveTranscript(request, { root });
      await rm(filePath);
      const second = await resolveTranscript(request, { root });

      // Then: second resolve reports absent rather than a stale ok.
      expect(first.kind).toBe("ok");
      expect(second).toMatchObject({ kind: "missing", reason: "absent" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("same-path ok then rewritten is visible on next resolve", async () => {
    // Given: a present transcript rewritten after a successful resolve.
    const root = await mkdtemp(join(tmpdir(), "lando-transcript-cache-"));
    const filePath = transcriptPathFor(request, root);
    if (filePath === undefined) throw new Error("expected a safe transcript path");
    await mkdir(join(root, request.guideId), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(minimalOk)}\n`, "utf8");

    try {
      // When: resolve, rewrite bytes, resolve again.
      const first = await resolveTranscript(request, { root });
      await writeFile(filePath, `${JSON.stringify(rewrittenOk)}\n`, "utf8");
      const second = await resolveTranscript(request, { root });

      // Then: second resolve surfaces rewritten frame content.
      expect(first.kind).toBe("ok");
      expect(second.kind).toBe("ok");
      if (first.kind !== "ok" || second.kind !== "ok") throw new Error("expected ok pair");
      expect(first.view.frames[0]).toMatchObject({ commandDisplay: "lando start" });
      expect(second.view.frames[0]).toMatchObject({
        commandDisplay: "lando info",
        resultSummary: "rewritten",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("overlapping concurrent resolves perform one read", async () => {
    // Given: a slow injectable read that counts invocations for one path.
    const root = await mkdtemp(join(tmpdir(), "lando-transcript-cache-"));
    const filePath = transcriptPathFor(request, root);
    if (filePath === undefined) throw new Error("expected a safe transcript path");
    await mkdir(join(root, request.guideId), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(minimalOk)}\n`, "utf8");
    let reads = 0;
    const readFileCounted: TranscriptReadFile = async (path) => {
      reads += 1;
      await Bun.sleep(40);
      return await readFile(path, "utf8");
    };

    try {
      // When: two resolves overlap on the same path.
      const [a, b] = await Promise.all([
        resolveTranscript(request, { root, readFile: readFileCounted }),
        resolveTranscript(request, { root, readFile: readFileCounted }),
      ]);

      // Then: in-flight dedupe shares one read; both resolve ok.
      expect(reads).toBe(1);
      expect(a.kind).toBe("ok");
      expect(b.kind).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("docs public transcript path containment", () => {
  test("rejects unsafe guideId and scenarioId shapes as missing", async () => {
    // Given: traversal and absolute-shaped ids.
    const cases = [
      { guideId: "../../etc", scenarioId: "happy-path", variant: "" },
      { guideId: "..", scenarioId: "happy-path", variant: "" },
      { guideId: "a/b", scenarioId: "happy-path", variant: "" },
      { guideId: "/etc", scenarioId: "happy-path", variant: "" },
      { guideId: "demo", scenarioId: "../x", variant: "" },
      { guideId: "demo", scenarioId: "a/b", variant: "" },
    ] as const satisfies ReadonlyArray<TranscriptRequest>;

    // When/Then: path building refuses and resolve returns build-safe missing.
    for (const request of cases) {
      expect(isSafeTranscriptRequest(request)).toBe(false);
      expect(transcriptPathFor(request, TRANSCRIPT_ROOT)).toBeUndefined();
      const result = await resolveTranscript(request, { root: TRANSCRIPT_ROOT });
      expect(result).toMatchObject({ kind: "missing", reason: "absent", request });
    }
  });

  test("rejects unsafe variant tokens while keeping legal multi-axis filenames", async () => {
    // Given: legal version-like values and unsafe separators / traversal / NUL.
    const legal = {
      guideId: "demo",
      scenarioId: "happy-path",
      variant: "php=v8-3 database=mariadb",
    } satisfies TranscriptRequest;
    const unsafe: ReadonlyArray<TranscriptRequest> = [
      { guideId: "demo", scenarioId: "happy-path", variant: "php=v8-3/../x" },
      { guideId: "demo", scenarioId: "happy-path", variant: "php=.." },
      { guideId: "demo", scenarioId: "happy-path", variant: "php=a\\b" },
      { guideId: "demo", scenarioId: "happy-path", variant: "php=a\0b" },
      { guideId: "demo", scenarioId: "happy-path", variant: "../=x" },
      { guideId: "demo", scenarioId: "happy-path", variant: "PHP=v8-3" },
    ];

    // When/Then: legal paths stay injective; unsafe variants never leave the root.
    expect(isSafeTranscriptRequest(legal)).toBe(true);
    expect(transcriptPathFor(legal, TRANSCRIPT_ROOT)).toBe(
      join(TRANSCRIPT_ROOT, "demo", "happy-path.php=v8-3.database=mariadb.json"),
    );
    for (const request of unsafe) {
      expect(isSafeTranscriptRequest(request)).toBe(false);
      expect(transcriptPathFor(request, TRANSCRIPT_ROOT)).toBeUndefined();
      const result = await resolveTranscript(request, { root: TRANSCRIPT_ROOT });
      expect(result.kind).toBe("missing");
    }
  });

  test("rejects duplicate axes and multi-equals values", async () => {
    // Given: well-shaped tokens that violate pair uniqueness / single-equals form.
    const cases = [
      { guideId: "demo", scenarioId: "happy-path", variant: "php=v8-3 php=8-4" },
      { guideId: "demo", scenarioId: "happy-path", variant: "php=v8-3=extra" },
    ] as const satisfies ReadonlyArray<TranscriptRequest>;

    // When/Then: path building refuses both.
    for (const request of cases) {
      expect(isSafeTranscriptRequest(request)).toBe(false);
      expect(transcriptPathFor(request, TRANSCRIPT_ROOT)).toBeUndefined();
    }
  });
});
