# VoltAgent Callback Resume

Start a synthetic fulfillment job, let the workflow suspend, then deliver a callback from a new process. The example uses VoltAgent's [suspend and resume](https://voltagent.dev/docs/workflows/suspend-resume/) workflow API, its workflow registry, and the official [LibSQL memory adapter](https://voltagent.dev/docs/agents/memory/libsql/) backed by a local SQLite file.

## Run the example

Use Node.js 22.13 or later. Install the locked dependencies once. Each demo command below starts a separate process. The shell variable carries the execution ID across those processes.

```sh
npm ci --ignore-scripts
demo_execution=$(
  npm run --silent demo -- start .voltagent/demo.db fixtures/job.json |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).executionId'
)
npm run --silent demo -- inspect .voltagent/demo.db "$demo_execution"
npm run --silent demo -- callback .voltagent/demo.db "$demo_execution" fixtures/delivered.json
npm run --silent demo -- callback .voltagent/demo.db "$demo_execution" fixtures/delivered.json
npm run --silent demo -- inspect .voltagent/demo.db "$demo_execution"
```

The run starts as `suspended`. The first matching callback resumes it and persists `completed` with the accepted event ID and carrier status. Replaying the same event returns `duplicate` and the saved result.

The input fixtures use a synthetic job ID and token. The database stores a SHA-256 digest of the token. The callback handler checks both the job ID and token before resuming, and passes only the job ID, event ID and carrier status to VoltAgent. Invalid or nonmatching callbacks leave the saved run unchanged. A different event after completion and a replay with conflicting content are also ignored.

## Verify locally

```sh
npm run check
npm test
```

The tests start a separate process for each command, disable fetch, socket connections and server startup in the child, and assert that the same execution survives exit and resumes from disk. They also exercise wrong IDs and tokens, repeat events and competing terminal callbacks.

## Scope

The CLI accepts local JSON files and opens no HTTP server. It records a terminal outcome of `delivered` or `delivery_failed` without sending notifications or updating a carrier or order system. The local lock serializes commands against the same database. A command returns exit code **0** for a recorded or ignored result, **2** for invalid input or a runtime failure, and **75** when another command holds the database lock. If a process is killed while holding the lock, verify it has stopped before removing the sibling `.lock` file.

The fixtures and token check demonstrate correlation and replay handling on one machine. A real callback receiver needs provider signature verification, an authenticated account boundary, durable event deduplication and a write strategy for downstream effects. VoltAgent 2.11.1 leaves a signal-check timer after a successful resume. This one-shot CLI closes its database and observability, drains output, and then exits.

For implementation context, see [Fnctn's workflow automation service](https://fnctn.io/services/workflow-automation/).

## License

MIT · Fnctn Inc.
