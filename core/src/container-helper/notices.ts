import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

const CONTAINER_HELPER_GO_LICENSE = "licenses/go/LICENSE";
const CONTAINER_HELPER_GO_PATENTS = "licenses/go/PATENTS";
const CONTAINER_HELPER_NOTICE_MANIFEST = "licenses/go/files.json";

export class ContainerHelperNoticeError extends Schema.TaggedError<ContainerHelperNoticeError>()(
  "ContainerHelperNoticeError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const noticeFiles = Schema.Array(Schema.Literals([CONTAINER_HELPER_GO_LICENSE, CONTAINER_HELPER_GO_PATENTS]));

export const containerHelperNotices = async (dist: string): Promise<readonly string[]> => {
  try {
    const files = Schema.decodeUnknownSync(Schema.fromJsonString(noticeFiles))(
      await readFile(join(dist, CONTAINER_HELPER_NOTICE_MANIFEST), "utf8"),
    );
    if (!files.includes(CONTAINER_HELPER_GO_LICENSE)) throw new Error("Go LICENSE is absent from inventory");
    for (const file of files) {
      if ((await readFile(join(dist, file))).byteLength === 0) throw new Error(`Empty notice: ${file}`);
    }
    return files.map((file) => join(dist, file));
  } catch (cause) {
    throw new ContainerHelperNoticeError({
      message: `Container helper Go notices are missing or incomplete in ${dist}.`,
      remediation:
        "Run `bun run scripts/build-container-helper.ts --test` or download the complete container-helper artifact from the same commit, including licenses/go/.",
      cause,
    });
  }
};
