import { Schema } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

const ts = "2026-06-18T12:00:00.000Z";

const treeStart = (label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId: "frame",
    label,
    children,
    timestamp: ts,
  });
const start = (taskId: string, label: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    parentId: "frame",
    taskId,
    label,
    timestamp: ts,
  });
const detail = (taskId: string, line: string, stream: "stdout" | "stderr" = "stdout"): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({ _tag: "task.detail", taskId, stream, line, timestamp: ts });
const complete = (taskId: string, summary: string, durationMs = 820): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary,
    durationMs,
    timestamp: ts,
  });
const fail = (taskId: string, summary: string, remediation: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskFailEvent)({
    _tag: "task.fail",
    taskId,
    summary,
    exitCode: 1,
    remediation,
    durationMs: 1310,
    timestamp: ts,
  });
const treeComplete = (summary: string, succeeded: number, failed: number): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "frame",
    summary,
    succeeded,
    failed,
    durationMs: 1520,
    timestamp: ts,
  });

const TREE_STAGES = {
  start: [treeStart("Starting app", ["appserver", "database"]), start("appserver", "appserver")],
  detail: [
    treeStart("Starting app", ["appserver", "database"]),
    start("appserver", "appserver"),
    detail("appserver", "listening on 0.0.0.0:8080"),
    detail("appserver", "npm warn deprecated foo@1.0.0", "stderr"),
  ],
  complete: [
    treeStart("Starting app", ["appserver", "database"]),
    start("appserver", "appserver"),
    complete("appserver", "appserver online", 820),
    start("database", "database"),
    complete("database", "database online", 540),
    treeComplete("App online", 2, 0),
  ],
  fail: [
    treeStart("Building app dependencies", ["appserver", "node"]),
    start("appserver", "composer install"),
    start("node", "npm ci"),
    fail("node", "npm ci", "see lando logs node --build"),
    treeComplete("Build blocked", 1, 1),
  ],
} as const satisfies Record<string, ReadonlyArray<LandoEvent>>;

interface TreeFixture {
  readonly id: string;
  readonly events: ReadonlyArray<LandoEvent>;
}

export const TREE_FIXTURES: ReadonlyArray<TreeFixture> = [
  { id: "tree.start", events: TREE_STAGES.start },
  { id: "tree.detail", events: TREE_STAGES.detail },
  { id: "tree.complete", events: TREE_STAGES.complete },
  { id: "tree.fail", events: TREE_STAGES.fail },
];

export const TREE_RESIZE_EVENTS = TREE_STAGES.detail;

/** Narrow (40-column) tree fixtures exercising sub-60 framing for ASCII and CJK. */
export const NARROW_TREE_FIXTURES: ReadonlyArray<TreeFixture> = [
  {
    id: "tree.narrow-ascii",
    events: [
      treeStart("Starting application services now", ["appserver", "database"]),
      start("appserver", "appserver bootstrapping the runtime"),
      detail("appserver", "listening on 0.0.0.0:8080 for incoming requests"),
    ],
  },
  {
    id: "tree.narrow-cjk",
    events: [
      treeStart("한글 애플리케이션 시작 중입니다 지금", ["웹서버"]),
      start("웹서버", "웹서버 런타임을 부팅하는 중"),
      detail("웹서버", "포트 8080 에서 수신 대기 중입니다 지금"),
    ],
  },
];

const promptRequest = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  prompt: { name: "answer", type, message: "Choose a flavor", ...extra },
  mode: type === "confirm" ? "confirm" : "normal",
  ...(type === "select"
    ? {
        choices: [
          { value: "vanilla", label: "Vanilla" },
          { value: "chocolate", label: "Chocolate" },
        ],
      }
    : {}),
});

const multiselectChoices = [
  { value: "vanilla", label: "Vanilla" },
  { value: "chocolate", label: "Chocolate" },
  { value: "strawberry", label: "Strawberry" },
];

const multiselectRequest = (defaultRaw?: string): Record<string, unknown> => ({
  prompt: { name: "flavors", type: "multiselect", message: "Choose flavors" },
  mode: "normal",
  choices: multiselectChoices,
  ...(defaultRaw === undefined ? {} : { defaultRaw }),
});

interface PromptFixture {
  readonly id: string;
  readonly request: Record<string, unknown>;
}

/** Prompt-chrome fixtures for every prompt type the renderer draws; only secret falls back to the line reader. */
export const PROMPT_FIXTURES: ReadonlyArray<PromptFixture> = [
  { id: "prompt.text", request: promptRequest("text", { default: "myapp" }) },
  { id: "prompt.number", request: promptRequest("number", { default: 8080 }) },
  { id: "prompt.path", request: promptRequest("path") },
  { id: "prompt.editor", request: promptRequest("editor") },
  { id: "prompt.select", request: promptRequest("select") },
  { id: "prompt.multiselect", request: multiselectRequest() },
  { id: "prompt.multiselect-checked", request: multiselectRequest("1,3") },
  {
    id: "prompt.confirm",
    request: {
      prompt: { name: "trust", type: "confirm", message: "Trust this plugin?" },
      mode: "confirm",
      defaultRaw: "no",
    },
  },
];

/** Narrow (40-column) prompt fixtures: ASCII title and a Korean+emoji title that must stay visible and within width. */
export const NARROW_PROMPT_FIXTURES: ReadonlyArray<PromptFixture> = [
  {
    id: "prompt.text-narrow",
    request: { prompt: { name: "answer", type: "text", message: "Choose a flavor" }, mode: "normal" },
  },
  {
    id: "prompt.cjk-narrow",
    request: {
      prompt: { name: "answer", type: "text", message: "한글 제목 매우 길어요 정말로 길다 🙂 끝" },
      mode: "normal",
    },
  },
];
