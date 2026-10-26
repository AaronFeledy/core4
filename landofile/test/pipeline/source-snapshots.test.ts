import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import * as parser from "../../src/parser.ts";
import { getSourceDocuments } from "../../src/pipeline/source-table.ts";
import { prepareLandofileSource, resolveLandofileSourceExpressions } from "../../src/source.ts";

test("prepares the retained authored snapshot without rereading the changed source", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-source-snapshot-"));
  try {
    // Given
    const file = join(root, ".lando.yml");
    const content = "name: snapshot\nservices:\n  web:\n    working_dir: /original\n    primary: wrong\n";
    await Bun.write(file, content);
    const acquired = await Effect.runPromise(prepareLandofileSource(file));
    await Bun.write(file, "name: replaced\n");
    // When
    const prepared = await Effect.runPromise(resolveLandofileSourceExpressions(acquired));
    // Then
    expect(prepared.value).toMatchObject({
      name: "snapshot",
      services: { web: { workingDirectory: "/original", primary: "wrong" } },
    });
    expect(getSourceDocuments(prepared.value)).toEqual([
      {
        file,
        form: "yaml",
        layer: "canonical",
        content,
        digest: sha256Hex(content),
        document: acquired.value,
      },
    ]);
    expect(acquired.value).toMatchObject({ services: { web: { working_dir: "/original" } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquires YAML with an ignored reset expression through one parser invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-source-once-"));
  const parse = spyOn(parser, "parseLandofile");
  try {
    // Given
    const file = join(root, ".lando.yml");
    await Bun.write(
      file,
      'name: once\nservices:\n  web:\n    environment:\n      OLD: !reset "{{ missing.value }}"\n',
    );
    // When
    const source = await Effect.runPromise(prepareLandofileSource(file));
    // Then
    expect(parse).toHaveBeenCalledTimes(1);
    expect(source.value).toMatchObject({ name: "once" });
  } finally {
    parse.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
