import { readFile } from "node:fs/promises";

export default function evalContextFixturePlugin() {
  return {
    name: "freestyle-eval-context-fixture",

    async resolveRecognitionContext(_input, output) {
      const snapshotFile = process.env.FREESTYLE_EVAL_SNAPSHOT_FILE;
      if (!snapshotFile) return;

      try {
        output.snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
    },
  };
}
