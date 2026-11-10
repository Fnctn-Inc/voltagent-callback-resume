import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const offline = new URL("./no-network.ts", import.meta.url).href;
const job = fileURLToPath(new URL("../fixtures/job.json", import.meta.url));
const delivered = fileURLToPath(new URL("../fixtures/delivered.json", import.meta.url));
const event = JSON.parse(await readFile(delivered, "utf8"));

function command(...args: string[]) {
  return new Promise<{ code: number | string | null; json: any; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [
      "--no-warnings=ExperimentalWarning", "--experimental-strip-types", "--import", offline, cli, ...args,
    ], { timeout: 15_000 }, (error, stdout, stderr) => {
      try {
        resolve({ code: error ? error.code ?? null : 0, json: stdout ? JSON.parse(stdout) : null, stderr });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function scenario(t: TestContext) {
  const temp = await mkdtemp(join(tmpdir(), "volt-callback-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const db = join(temp, "state with spaces.db");
  const start = await command("start", db, job);
  assert.equal(start.code, 0, start.stderr);
  assert.equal(start.json.status, "suspended");
  const executionId: string = start.json.executionId;

  async function fixture(name: string, changes: Record<string, unknown>) {
    const path = join(temp, name + ".json");
    await writeFile(path, JSON.stringify({ ...event, ...changes }));
    return path;
  }

  return {
    db,
    executionId,
    fixture,
    inspect: () => command("inspect", db, executionId),
    callback: (path: string) => command("callback", db, executionId, path),
  };
}

test("a fresh process reads and resumes a suspended run, then observes persisted completion", async (t) => {
  const demo = await scenario(t);
  assert.deepEqual((await demo.inspect()).json, {
    status: "suspended", executionId: demo.executionId, jobId: "demo-order-307",
  });

  const applied = await demo.callback(delivered);
  const result = { jobId: "demo-order-307", eventId: "demo-event-501", carrierStatus: "delivered" };
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(applied.json, { status: "completed", executionId: demo.executionId, result });
  assert.deepEqual((await demo.inspect()).json, { status: "completed", executionId: demo.executionId, jobId: result.jobId, result });
  assert.deepEqual((await demo.callback(delivered)).json, { status: "duplicate", executionId: demo.executionId, result });
  const conflicting = await demo.fixture("conflict", { carrierStatus: "delivery_failed" });
  assert.deepEqual((await demo.callback(conflicting)).json, { status: "ignored", reason: "conflicting_replay" });
  const later = await demo.fixture("later", { eventId: "demo-event-502" });
  assert.deepEqual((await demo.callback(later)).json, { status: "ignored", reason: "already_terminal" });
  assert.deepEqual((await demo.inspect()).json.result, result);
  assert.equal((await readFile(demo.db)).includes(Buffer.from(event.token)), false);
});

test("a wrong job, wrong token or unknown execution leaves the workflow waiting", async (t) => {
  const demo = await scenario(t);
  const wrongJob = await demo.fixture("wrong-job", { jobId: "demo-order-999" });
  assert.deepEqual((await demo.callback(wrongJob)).json, { status: "ignored", reason: "wrong_job" });
  const wrongToken = await demo.fixture("wrong-token", { token: "demo_wrong_token_never_accept" });
  assert.deepEqual((await demo.callback(wrongToken)).json, { status: "ignored", reason: "wrong_token" });
  assert.deepEqual((await command("callback", demo.db, "d6b29417-b9c9-4aa5-872f-e168a943a11a", delivered)).json,
    { status: "ignored", reason: "unknown_execution" });
  assert.equal((await demo.inspect()).json.status, "suspended");

  const malformed = await demo.fixture("malformed", { carrierStatus: "in_transit" });
  const rejected = await demo.callback(malformed);
  assert.equal(rejected.code, 2);
  assert.equal(rejected.json, null);
  assert.doesNotMatch(rejected.stderr, /demo_wrong_token|demo_token_for|in_transit/);
  assert.equal((await demo.inspect()).json.status, "suspended");
});

test("competing terminal callbacks can complete the workflow only once", async (t) => {
  const demo = await scenario(t);
  const failed = await demo.fixture("failed", { eventId: "demo-event-502", carrierStatus: "delivery_failed" });
  const results = await Promise.all([demo.callback(delivered), demo.callback(failed)]);
  const applied = results.filter(({ json }) => json?.status === "completed");
  assert.equal(applied.length, 1);
  const other = results.find(({ json }) => json?.status !== "completed")!;
  if (other.code === 75) {
    assert.deepEqual(other.json, { status: "busy" });
  } else {
    assert.equal(other.code, 0, other.stderr);
    assert.deepEqual(other.json, { status: "ignored", reason: "already_terminal" });
  }
  assert.deepEqual((await demo.inspect()).json.result, applied[0].json.result);
});
