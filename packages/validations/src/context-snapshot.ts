import { z } from "zod/v3";

const boundedString = (maxLength: number) =>
  z.string().transform((value) => value.slice(0, maxLength));

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.optional().catch(undefined);

const boundedStringList = z
  .array(boundedString(200))
  .transform((values) => values.slice(0, 100));

export const contextSnapshotSchema = z.object({
  capturedAt: z.number(),
  app: optional(
    z.object({
      name: boundedString(200),
      windowTitle: optional(boundedString(500)),
      wmClass: optional(boundedString(200)),
      url: optional(boundedString(2_000)),
    }),
  ),
  terminal: optional(
    z.object({
      paneText: boundedString(3_000),
    }),
  ),
  editor: optional(
    z.object({
      file: optional(boundedString(500)),
      language: optional(boundedString(100)),
      visibleText: optional(boundedString(2_000)),
      symbols: optional(boundedStringList),
      openBuffers: optional(boundedStringList),
    }),
  ),
  focusText: optional(
    z.object({
      before: boundedString(2_000),
      selected: optional(boundedString(500)),
      after: optional(boundedString(500)),
      role: optional(boundedString(100)),
    }),
  ),
});

/**
 * Keep this structural type aligned with `ContextSnapshot` in `freestyle-voice`,
 * which owns the public plugin contract without depending on this private package.
 */
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

/** Parse an untrusted desktop snapshot without exposing validation failures. */
export function parseContextSnapshot(raw: unknown): ContextSnapshot | null {
  try {
    const result = contextSnapshotSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
