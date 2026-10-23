/** Map items with a small worker pool while retaining input-order results. */
export async function runBoundedWorkers(items, concurrency, worker, shouldStop = () => false) {
    const results = new Array(items.length);
    if (items.length === 0)
        return results;

    const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
    const workerCount = Math.min(items.length, Math.max(1, requested));
    let nextIndex = 0;
    let failure;
    let hasFailed = false;

    const runWorker = async () => {
        while (!hasFailed && !shouldStop()) {
            const index = nextIndex++;
            if (index >= items.length)
                return;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                // Stop handing out work after the first failure. Other in-flight
                // workers may finish, but the caller receives the original error.
                if (!hasFailed) {
                    failure = error;
                    hasFailed = true;
                }
                return;
            }
        }
    };

    await Promise.all(Array.from({length: workerCount}, () => runWorker()));
    if (hasFailed)
        throw failure;
    // Return a dense result array: stopped/unassigned work is explicitly undefined.
    return Array.from(results);
}
