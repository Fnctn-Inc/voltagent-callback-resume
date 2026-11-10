import { z } from "zod";

const demoId = z.string().regex(/^demo-[a-z0-9-]{1,48}$/);
const token = z.string().regex(/^[a-zA-Z0-9_-]{20,128}$/);
const carrierStatus = z.enum(["delivered", "delivery_failed"]);

export const jobSchema = z.strictObject({ jobId: demoId, token });
export const executionIdSchema = z.uuid();

export const persistedJobSchema = z.strictObject({
  jobId: demoId,
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const resultSchema = z.strictObject({
  jobId: demoId,
  eventId: demoId,
  carrierStatus,
});

export const callbackSchema = resultSchema.extend({ token });

export type Job = z.infer<typeof jobSchema>;
export type Callback = z.infer<typeof callbackSchema>;
