import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { KeymapConflictError } from "@lando/sdk/errors";
import { CodeSnippetEvent, DiffRenderEvent, MarkdownBlockEvent, RenderEvent } from "@lando/sdk/events";
import {
  KeymapConfig,
  PanelView,
  PluginManifest,
  PublishedGlobalConfigKey,
  RendererActionId,
  RendererKeyChord,
  RendererPanelId,
  RendererPanelManifestEntry,
  RendererPanelSlot,
  RendererPanelWatch,
  SubscriberManifestEntry,
  SubscriberSelector,
  decodeKeymapConfig,
  validateKeymapConfigConflicts,
} from "@lando/sdk/schema";

describe("4.1 renderer surface freeze (schemas)", () => {
  test("panel slot vocabulary and manifest entry decode", () => {
    expect(Schema.decodeUnknownSync(RendererPanelSlot)("status-bar")).toBe("status-bar");
    expect(Either.isLeft(Schema.decodeUnknownEither(RendererPanelSlot)("unknown"))).toBe(true);

    const id = Schema.decodeUnknownSync(RendererPanelId)("build-status");
    const watch = Schema.decodeUnknownSync(RendererPanelWatch)(["post-start", "post-stop"]);
    const entry = Schema.decodeUnknownSync(RendererPanelManifestEntry)({
      id,
      slot: "status-bar",
      watch,
      module: "./panels/status.ts",
    });
    expect(entry.slot).toBe("status-bar");
    expect(Either.isLeft(Schema.decodeUnknownEither(RendererPanelWatch)(["a", "a"]))).toBe(true);
  });

  test("PanelView enforces row/span/byte bounds without clipping", () => {
    const ok = Schema.decodeUnknownSync(PanelView)([[{ text: "hi" }]]);
    expect(ok).toHaveLength(1);

    const nineRows = Array.from({ length: 9 }, () => [{ text: "x" }]);
    expect(Either.isLeft(Schema.decodeUnknownEither(PanelView)(nineRows))).toBe(true);

    const big = [[{ text: "x".repeat(5000) }]];
    expect(Either.isLeft(Schema.decodeUnknownEither(PanelView)(big))).toBe(true);
  });

  test("keymap chord grammar rejects reserved ctrl+c and unknown keys as schema failure", () => {
    expect(Schema.decodeUnknownSync(RendererKeyChord)("ctrl+alt+shift+f")).toBe("ctrl+alt+shift+f");
    expect(Either.isLeft(Schema.decodeUnknownEither(RendererKeyChord)("ctrl+c"))).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(RendererKeyChord)("shift+ctrl+f"))).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(RendererKeyChord)("?"))).toBe(true);
    expect(Schema.decodeUnknownSync(RendererActionId)("tree.expand")).toBe("tree.expand");
  });

  test("KeymapConfig decodes; same-surface conflict is a separate step", () => {
    const ok = Schema.decodeUnknownSync(KeymapConfig)({
      "tree.expand": "space",
      "viewer.quit": ["q", "ctrl+d"],
    });
    expect(ok["tree.expand"]).toBe("space");
    expect(Either.isRight(validateKeymapConfigConflicts(ok))).toBe(true);

    const colliding = Schema.decodeUnknownSync(KeymapConfig)({
      "tree.expand": "enter",
      "tree.collapse": "enter",
    });
    const conflict = validateKeymapConfigConflicts(colliding);
    expect(Either.isLeft(conflict)).toBe(true);
    if (Either.isLeft(conflict)) {
      expect(conflict.left).toBeInstanceOf(KeymapConflictError);
      expect(conflict.left.surface).toBe("task-tree");
      expect(conflict.left.chord).toBe("enter");
    }

    const crossSurface = Schema.decodeUnknownSync(KeymapConfig)({
      "tree.expand": "f",
      "viewer.follow": "f",
    });
    expect(Either.isRight(validateKeymapConfigConflicts(crossSurface))).toBe(true);

    const reserved = decodeKeymapConfig({ "prompt.cancel": "ctrl+c" });
    expect(Either.isLeft(reserved)).toBe(true);
  });

  test("rich render events require positive line numbers", () => {
    const snippet = Schema.decodeUnknownSync(CodeSnippetEvent)({
      _tag: "code.snippet",
      code: "const x = 1",
      startLine: 1,
      highlightLines: [1, 2],
    });
    expect(snippet.code).toBe("const x = 1");
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(CodeSnippetEvent)({
          _tag: "code.snippet",
          code: "x",
          startLine: 0,
        }),
      ),
    ).toBe(true);

    expect(
      Schema.decodeUnknownSync(DiffRenderEvent)({
        _tag: "diff.render",
        unified: "--- a\n+++ b\n",
      }).unified,
    ).toContain("+++");
    expect(
      Schema.decodeUnknownSync(MarkdownBlockEvent)({
        _tag: "markdown.block",
        markdown: "# hi",
      }).markdown,
    ).toBe("# hi");

    const render = Schema.decodeUnknownSync(RenderEvent)({
      _tag: "notify.desktop",
      title: "done",
    });
    expect(render._tag).toBe("notify.desktop");
  });

  test("subscriber manifest entry and published config key", () => {
    expect(Schema.decodeUnknownSync(PublishedGlobalConfigKey)("notify")).toBe("notify");
    expect(Either.isLeft(Schema.decodeUnknownEither(PublishedGlobalConfigKey)("other"))).toBe(true);

    const selector = Schema.decodeUnknownSync(SubscriberSelector)({ family: "cli-command-terminal" });
    expect("family" in selector).toBe(true);

    const entry = Schema.decodeUnknownSync(SubscriberManifestEntry)({
      id: "notify-on-command-terminal",
      selectors: [{ family: "cli-command-terminal" }],
      module: "./src/subscribers/notify.ts",
      priority: 900,
      configKey: "notify",
    });
    expect(entry.priority).toBe(900);
    expect(entry.abortOnError).toBe(false);

    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(SubscriberManifestEntry)({
          id: "bad",
          selectors: [{ family: "cli-command-terminal" }],
          module: "./x.ts",
          priority: 50,
        }),
      ),
    ).toBe(true);
  });

  test("PluginManifest accepts rendererPanels and subscribers", () => {
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: "@lando/example",
      version: "0.0.0",
      api: 4,
      contributes: {
        rendererPanels: [
          {
            id: "build-status",
            slot: "status-bar",
            watch: ["post-start"],
            module: "./panels/status.ts",
          },
        ],
      },
      subscribers: [
        {
          id: "audit",
          selectors: [{ event: "post-start" }],
          module: "./subscribers/audit.ts",
        },
      ],
    });
    expect(manifest.contributes?.rendererPanels?.[0]?.id).toBe("build-status");
    expect(manifest.subscribers?.[0]?.id).toBe("audit");
  });
});
