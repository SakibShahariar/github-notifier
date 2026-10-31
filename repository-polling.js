// Watched-repository polling. The indicator remains the owner of API access and web-host settings.
function isValidEtag(value) {
    return typeof value === 'string' &&
        value.length <= 512 &&
        /^(?:W\\/)?"[^"\\u0000-\\u001f\\u007f]*"$/.test(value);
}

async function requestRepositoryData(indicator, path, etag = null) {
    if (typeof indicator._apiRequest !== 'function')
        return {data: await indicator._apiGet(path), etag: null, notModified: false};
    const headers = etag && isValidEtag(etag) ? {'If-None-Match': etag} : {};
    return indicator._apiRequest('GET', path, {headers});
}
// Repair malformed nested cache containers before reading or updating baselines.
function getRepositoryState(state, repo) {
    if (!state.repos || typeof state.repos !== 'object' || Array.isArray(state.repos))
        state.repos = {};
    const existing = state.repos[repo];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing))
        state.repos[repo] = {};
    return state.repos[repo];
}

export async function pollRepoIssues(indicator, repo, state, baselineNotes) {
        const repoState = getRepositoryState(state, repo);

        const issuesPath = `/repos/${indicator._encodeRepo(repo)}/issues?state=all&sort=created&direction=desc&per_page=20`;
        const hasValidBaseline = Number.isSafeInteger(repoState.lastIssueNumber) &&
            repoState.lastIssueNumber >= 0;
        let response = await requestRepositoryData(indicator, issuesPath, repoState.issuesEtag);
        if (response.notModified) {
            if (hasValidBaseline)
                return [];
            repoState.issuesEtag = null;
            response = await requestRepositoryData(indicator, issuesPath);
            if (response.notModified)
                throw new Error('GitHub returned 304 without an issue baseline');
        }
        const data = Array.isArray(response.data) ? response.data : [];
        repoState.issuesEtag = isValidEtag(response.etag) ? response.etag : null;
        const items = [];
        // Treat only non-negative safe integers as valid baselines. Zero is a
        // valid baseline for a repository that had no issues when first watched;
        // malformed persisted values must trigger a silent re-baseline, not suppress alerts.
        const lastIssueNumber = hasValidBaseline ? repoState.lastIssueNumber : 0;
        let maxId = lastIssueNumber;
        const seenAnyBefore = hasValidBaseline;

        for (const issue of data) {
            const isPR = !!issue.pull_request;
            if (seenAnyBefore && issue.number > lastIssueNumber) {
                items.push({
                    id: `${repo}-${issue.number}`,
                    title: `${isPR ? 'New PR' : 'New issue'}: ${issue.title}`,
                    subtitle: repo,
                    url: issue.html_url,
                    kind: isPR ? 'pr' : 'issue',
                    ts: issue.created_at,
                });
            }
            if (issue.number > maxId)
                maxId = issue.number;
        }

        if (seenAnyBefore && items.length === 20) {
            try {
                const data2 = await indicator._apiGet(`/repos/${indicator._encodeRepo(repo)}/issues?state=all&sort=created&direction=desc&per_page=20&page=2`);
                for (const issue of data2) {
                    if (issue.number > maxId)
                        maxId = issue.number;
                }
                const hasMoreNew = data2.some(issue => issue.number > lastIssueNumber);
                if (hasMoreNew) {
                    items.push({
                        id: `${repo}-more-${maxId}`,
                        title: 'More new issues/PRs than shown — check the repo directly',
                        subtitle: repo,
                        url: `${indicator._webBase()}/${repo}/issues`,
                        kind: 'issue',
                        ts: new Date().toISOString(),
                    });
                }
            } catch (e) {
                items.push({
                    id: `${repo}-more-${maxId}`,
                    title: 'More new issues/PRs than shown — check the repo directly',
                    subtitle: repo,
                    url: `${indicator._webBase()}/${repo}/issues`,
                    kind: 'issue',
                    ts: new Date().toISOString(),
                });
            }
        }

        if (!seenAnyBefore) {
            baselineNotes.push(`${repo}: now tracking issues/PRs (baseline established from recent items)`);
        }

        repoState.lastIssueNumber = maxId;
        repoState.issuesBaselineEstablished = true;
        return items;
    }

export async function pollRepoStars(indicator, repo, state, baselineNotes) {
        const repoState = getRepositoryState(state, repo);

        const hasBaseline = Number.isSafeInteger(repoState.stars) && repoState.stars >= 0;
        let response = await requestRepositoryData(indicator, `/repos/${indicator._encodeRepo(repo)}`, repoState.starsEtag);
        if (response.notModified) {
            if (hasBaseline)
                return [];
            repoState.starsEtag = null;
            response = await requestRepositoryData(indicator, `/repos/${indicator._encodeRepo(repo)}`);
            if (response.notModified)
                throw new Error('GitHub returned 304 without a star baseline');
        }
        const data = response.data && typeof response.data === 'object' ? response.data : {};
        const count = data.stargazers_count;
        if (!Number.isSafeInteger(count) || count < 0)
            throw new Error('GitHub returned an invalid star count');
        repoState.starsEtag = isValidEtag(response.etag) ? response.etag : null;
        const items = [];
        // Persisted state can be malformed or stale; only a valid GitHub star
        // count is a usable baseline, otherwise establish one silently.
        const hadBaseline = hasBaseline;

        if (hadBaseline && count > repoState.stars) {
            const gained = count - repoState.stars;
            items.push({
                id: `${repo}-stars-${count}`,
                title: `+${gained} new star${gained > 1 ? 's' : ''} (${count} total)`,
                subtitle: repo,
                url: `${indicator._webBase()}/${repo}/stargazers`,
                kind: 'star',
                ts: new Date().toISOString(),
            });
        }

        if (!hadBaseline)
            baselineNotes.push(`${repo}: now tracking stars (currently ${count})`);

        repoState.stars = count;
        return items;
    }

