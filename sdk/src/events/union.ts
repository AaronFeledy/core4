import { Schema } from "effect";

import {
  PostAppStartEvent,
  PostAppStopEvent,
  PostBuildEvent,
  PostServiceStartEvent,
  PostServiceStopEvent,
  PreAppStartEvent,
  PreAppStopEvent,
  PreBuildEvent,
  PreServiceStartEvent,
  PreServiceStopEvent,
} from "./app.ts";
import { BeforeExitEvent, PostBootstrapEvent, PreBootstrapEvent, ReadyEvent } from "./bootstrap.ts";
import { CliCommandErrorEvent, CliCommandInitEvent, CliCommandRunEvent } from "./cli.ts";
import {
  DataTransferProgressEvent,
  PostDataTransferEvent,
  PostVolumeSnapshotEvent,
  PreDataTransferEvent,
  PreVolumeSnapshotEvent,
} from "./data.ts";
import { DeprecationUsedEvent } from "./deprecation.ts";
import { DownloadProgressEvent, PostDownloadEvent, PreDownloadEvent } from "./download.ts";
import {
  PostGlobalStartEvent,
  PostGlobalStopEvent,
  PreGlobalStartEvent,
  PreGlobalStopEvent,
} from "./global.ts";
import { PostHttpCallEvent, PreHttpCallEvent } from "./http-call.ts";
import {
  PostDestroyEvent,
  PostInitEvent,
  PostRebuildEvent,
  PostStartEvent,
  PostStopEvent,
  PreDestroyEvent,
  PreInitEvent,
  PreRebuildEvent,
  PreStartEvent,
  PreStopEvent,
} from "./lifecycle.ts";
import {
  ManagedFileConflictDetectedEvent,
  ManagedFileSkippedEvent,
  PostManagedFileWriteEvent,
  PreManagedFileWriteEvent,
} from "./managed-file.ts";
import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "./message.ts";
import {
  PostProviderApplyEvent,
  PostProviderExecEvent,
  PreProviderApplyEvent,
  PreProviderExecEvent,
} from "./provider.ts";
import { PaintBannerEvent } from "./renderer.ts";
import {
  PostDatasetApplyEvent,
  PostDatasetCaptureEvent,
  PostDatasetFetchEvent,
  PostDatasetSendEvent,
  PostPullEvent,
  PostPushEvent,
  PreDatasetApplyEvent,
  PreDatasetCaptureEvent,
  PreDatasetFetchEvent,
  PreDatasetSendEvent,
  PrePullEvent,
  PrePushEvent,
} from "./sync.ts";
import {
  TaskCompleteEvent,
  TaskDetailCollapseEvent,
  TaskDetailEvent,
  TaskDetailExpandEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "./task.ts";
import {
  PostTunnelStartEvent,
  PostTunnelStopEvent,
  PreTunnelStartEvent,
  PreTunnelStopEvent,
  TunnelReadyEvent,
  TunnelStatusEvent,
} from "./tunnel.ts";

export const LandoEvent = Schema.Union(
  PreBootstrapEvent,
  PostBootstrapEvent,
  ReadyEvent,
  BeforeExitEvent,
  PreInitEvent,
  PostInitEvent,
  PreStartEvent,
  PostStartEvent,
  PreStopEvent,
  PostStopEvent,
  PreRebuildEvent,
  PostRebuildEvent,
  PreDestroyEvent,
  PostDestroyEvent,
  PreGlobalStartEvent,
  PostGlobalStartEvent,
  PreGlobalStopEvent,
  PostGlobalStopEvent,
  PreAppStartEvent,
  PostAppStartEvent,
  PreAppStopEvent,
  PostAppStopEvent,
  PreServiceStartEvent,
  PostServiceStartEvent,
  PreServiceStopEvent,
  PostServiceStopEvent,
  PreBuildEvent,
  PostBuildEvent,
  PreManagedFileWriteEvent,
  PostManagedFileWriteEvent,
  ManagedFileConflictDetectedEvent,
  ManagedFileSkippedEvent,
  PreDownloadEvent,
  DownloadProgressEvent,
  PostDownloadEvent,
  PreHttpCallEvent,
  PostHttpCallEvent,
  PreDataTransferEvent,
  DataTransferProgressEvent,
  PostDataTransferEvent,
  PreVolumeSnapshotEvent,
  PostVolumeSnapshotEvent,
  PrePullEvent,
  PostPullEvent,
  PrePushEvent,
  PostPushEvent,
  PreDatasetFetchEvent,
  PostDatasetFetchEvent,
  PreDatasetApplyEvent,
  PostDatasetApplyEvent,
  PreDatasetCaptureEvent,
  PostDatasetCaptureEvent,
  PreDatasetSendEvent,
  PostDatasetSendEvent,
  PreTunnelStartEvent,
  PostTunnelStartEvent,
  TunnelReadyEvent,
  PreTunnelStopEvent,
  PostTunnelStopEvent,
  TunnelStatusEvent,
  PreProviderApplyEvent,
  PostProviderApplyEvent,
  PreProviderExecEvent,
  PostProviderExecEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  CliCommandErrorEvent,
  DeprecationUsedEvent,
  TaskTreeStartEvent,
  TaskStartEvent,
  TaskDetailEvent,
  TaskDetailExpandEvent,
  TaskDetailCollapseEvent,
  TaskCompleteEvent,
  TaskFailEvent,
  TaskTreeCompleteEvent,
  MessageInfoEvent,
  MessageWarnEvent,
  MessageErrorEvent,
  PaintBannerEvent,
);
export type LandoEvent = typeof LandoEvent.Type;

export const SubscriberPriority = {
  critical: { min: 0, max: 9 },
  early: { min: 10, max: 99 },
  default: { min: 100, max: 999 },
  late: { min: 1000, max: 9999 },
  final: { min: 10000, max: Number.MAX_SAFE_INTEGER },
} as const;

export type SubscriberPriorityBand = keyof typeof SubscriberPriority;
