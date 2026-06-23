import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  type DatasetContractHarness,
  type RemoteSourceContractHarness,
  runDatasetContract,
  runRemoteSourceContract,
} from "@lando/sdk/test";

import { TestDataset, TestRemoteSource, localRemoteSource, makeTestRemoteSource } from "@lando/core/testing";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("RemoteSource + Dataset contract suites", () => {
  test("TestRemoteSource satisfies the RemoteSource contract", async () => {
    const harness: RemoteSourceContractHarness = {
      name: "TestRemoteSource",
      source: TestRemoteSource.source,
      config: TestRemoteSource.config,
      supportedEnv: TestRemoteSource.supportedEnv,
      protectedEnv: TestRemoteSource.protectedEnv,
      missingEnv: TestRemoteSource.missingEnv,
      supportedDataset: TestRemoteSource.supportedDataset,
      unsupportedDataset: TestRemoteSource.unsupportedDataset,
      noPushSource: TestRemoteSource.noPushSource,
      artifact: TestRemoteSource.artifact,
      observations: TestRemoteSource.observations,
      events: () => Effect.sync(() => TestRemoteSource.events()),
    };

    const result = await run(runRemoteSourceContract(harness));
    expect(result).toBeUndefined();
  });

  test("localRemoteSource satisfies the RemoteSource contract", async () => {
    const harness: RemoteSourceContractHarness = {
      name: "localRemoteSource",
      source: localRemoteSource.source,
      config: localRemoteSource.config,
      supportedEnv: localRemoteSource.supportedEnv,
      protectedEnv: localRemoteSource.protectedEnv,
      missingEnv: localRemoteSource.missingEnv,
      supportedDataset: localRemoteSource.supportedDataset,
      unsupportedDataset: localRemoteSource.unsupportedDataset,
      noPushSource: localRemoteSource.noPushSource,
      artifact: localRemoteSource.artifact,
      observations: localRemoteSource.observations,
      events: () => Effect.sync(() => localRemoteSource.events()),
    };

    const result = await run(runRemoteSourceContract(harness));
    expect(result).toBeUndefined();
  });

  test("no-tool TestRemoteSource satisfies the RemoteSource contract", async () => {
    const noTool = makeTestRemoteSource({ name: "no-tool" }).pipe(Effect.runSync);
    const harness: RemoteSourceContractHarness = {
      name: "no-tool TestRemoteSource",
      source: noTool.noToolSource,
      config: noTool.config,
      supportedEnv: noTool.supportedEnv,
      protectedEnv: noTool.protectedEnv,
      missingEnv: noTool.missingEnv,
      supportedDataset: noTool.supportedDataset,
      unsupportedDataset: noTool.unsupportedDataset,
      noPushSource: noTool.noPushSource,
      artifact: noTool.artifact,
      observations: noTool.observations,
      events: () => Effect.sync(() => noTool.events()),
    };

    const result = await run(runRemoteSourceContract(harness));
    expect(result).toBeUndefined();
  });

  test("TestDataset satisfies the Dataset contract", async () => {
    const harness: DatasetContractHarness = {
      name: "TestDataset",
      dataset: TestDataset.dataset,
      context: TestDataset.context,
      codeTreeContext: TestDataset.codeTreeContext,
      expectedBytes: TestDataset.expectedBytes,
      observations: TestDataset.observations,
      events: () => Effect.sync(() => TestDataset.events()),
      readAppliedBytes: () => Effect.sync(() => TestDataset.readAppliedBytes()),
    };

    const result = await run(runDatasetContract(harness));
    expect(result).toBeUndefined();
  });
});
