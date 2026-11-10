import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { callbackSchema, executionIdSchema, jobSchema } from "./schema.ts";

const usage = [
  "Usage:",
  "  npm run --silent demo -- start <state.db> <job.json>",
  "  npm run --silent demo -- inspect <state.db> <execution-id>",
  "  npm run --silent demo -- callback <state.db> <execution-id> <event.json>",
].join("\n");

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function isFileError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function main(): Promise<number> {
  const [command, dbFile, argument, eventFile, ...extra] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }
  if (!dbFile || !argument || extra.length > 0 ||
      !["start", "inspect", "callback"].includes(command) ||
      (command === "callback" ? !eventFile : Boolean(eventFile))) {
    console.error(usage);
    return 2;
  }

  let lock;
  let lockPath: string | undefined;
  try {
    process.umask(0o077);

    const executionId = command === "start" ? undefined : executionIdSchema.parse(argument);
    const job = command === "start" ? jobSchema.parse(await loadJson(argument)) : undefined;
    const callback = eventFile ? callbackSchema.parse(await loadJson(eventFile)) : undefined;
    const absolutePath = resolve(dbFile);
    await mkdir(dirname(absolutePath), { recursive: true });
    const dbPath = join(await realpath(dirname(absolutePath)), basename(absolutePath));

    try {
      const stat = await lstat(dbPath);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Use a regular, unlinked state file.");
    } catch (error) {
      if (!isFileError(error, "ENOENT")) throw error;
    }

    lockPath = dbPath + ".lock";
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
      console.log(JSON.stringify({ status: "busy" }));
      return 75;
    }

    const { openRuntime } = await import("./runtime.ts");
    const runtime = openRuntime(dbPath);
    let output;
    try {
      output = job ? await runtime.start(job)
        : callback ? await runtime.accept(executionId!, callback)
        : await runtime.inspect(executionId!);
    } finally {
      await runtime.close();
    }
    console.log(JSON.stringify(output));
    return 0;
  } catch {
    console.error("Unable to process the local workflow command. Check the command, fixture and state file.");
    return 2;
  } finally {
    if (lock && lockPath) {
      try {
        await lock.close();
      } finally {
        await unlink(lockPath);
      }
    }
  }
}

const exitCode = await main();
// VoltAgent 2.11.1 leaves a signal-check timer after a successful resume.
// The one-shot CLI closes storage and tracing first, then drains its output.
await Promise.all(
  [process.stdout, process.stderr].map((stream) => new Promise<void>((done) => stream.write("", () => done()))),
);
process.exit(exitCode);
