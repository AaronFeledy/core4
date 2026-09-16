export class FakeRestoreError extends Error {
  readonly _tag = "FakeRestoreError";
  constructor() {
    super("restore failed");
    this.name = "FakeRestoreError";
  }
}

export class FakeStartError extends Error {
  readonly _tag = "FakeStartError";
  constructor() {
    super("start failed");
    this.name = "FakeStartError";
  }
}
