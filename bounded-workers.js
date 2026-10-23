/** Map items with a small worker pool while retaining input-order results. */
export async function runBoundedWorkers(items, concurrency, worker, shouldStop = () => false) {
    const results = new Array(items.length);
    if (items.length === 0)
        return results;

    const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
    const workerCount = Math.min(items.length, Math.max(1, requested));
    let nextIndex = 0;

    const runWorker = async () => {
        while (!shouldStop()) {
            const index = nextIndex++;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index], index);
        }
    };

    await Promise.all(Array.from({length: workerCount}, () => runWorker()));
    return results;
}
