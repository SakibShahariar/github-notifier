// Standalone benchmark for issues #47/#7. Not a test (no .test.mjs suffix), so
// it is not run by CI; run it manually with:
//   node tests/benchmark-parallel-polling.mjs
//
// It models repository polling as a fixed network latency per request and
// compares serial execution with the bounded 3-worker pool actually used by
// poll-controller.js. Latency is simulated so results are reproducible and do
// not depend on GitHub availability or credentials.

import {runBoundedWorkers} from '../bounded-workers.js';

const LATENCY_MS = 20;
const SCENARIOS = [3, 10, 20, 30];

async function timedRun(repos, concurrency) {
    const started = process.hrtime.bigint();
    const results = await runBoundedWorkers(
        repos,
        concurrency,
        async repo => {
            await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
            return repo;
        },
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (results.length !== repos.length || results.some((value, i) => value !== repos[i]))
        throw new Error('result ordering or completeness violated');
    return elapsedMs;
}

console.log(`Repo polling benchmark · ${LATENCY_MS}ms simulated latency per repo\n`);
console.log('repos | serial (1) | pool (3) | speedup');
console.log('------+------------+----------+--------');
for (const count of SCENARIOS) {
    const repos = Array.from({length: count}, (_, i) => `owner/repo-${i + 1}`);
    const serial = await timedRun(repos, 1);
    const pool = await timedRun(repos, 3);
    console.log(
        `${String(count).padStart(5)} | ${serial.toFixed(1).padStart(10)} | ${pool.toFixed(1).padStart(8)} | ${(serial / pool).toFixed(2)}x`,
    );
}
console.log('\nExpected: the 3-worker pool approaches ~3x for larger watch lists.');
