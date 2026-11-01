export const listenerPrerequisites = (facts: {
  readonly socket: boolean;
  readonly binary: string | undefined;
  readonly image: string | undefined;
}): readonly string[] => [
  ...(!facts.socket ? ["LANDO_TEST_PODMAN_SOCKET must name an answering explicit socket"] : []),
  ...(!facts.binary?.trim() ? ["LANDO_SCENARIO_E2E_BINARY must name the current compiled CLI"] : []),
  ...(!facts.image?.trim() ? ["LANDO_TEST_MINIO_IMAGE must name an explicit BYO QA image"] : []),
];

export const assertListenerCompletion = (completed: readonly string[]): void => {
  const expected = ["mailpit-default", "mailpit-moved", "minio-default", "minio-moved"];
  if (completed.length !== expected.length || expected.some((id) => !completed.includes(id))) {
    throw new Error(
      `Listener acceptance incomplete: ${completed.length}/4 completed: ${completed.join(", ")}`,
    );
  }
};
