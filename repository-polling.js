// Watched-repository polling. The indicator remains the owner of API access and web-host settings.
export async function pollRepoIssues(indicator, repo, state, baselineNotes) {
        state.repos ||= {};
        state.repos[repo] ||= {};
        const repoState = state.repos[repo];

        const data = await indicator._apiGet(`/repos/${indicator._encodeRepo(repo)}/issues?state=all&sort=created&direction=desc&per_page=20`);
        const items = [];
        let maxId = repoState.lastIssueNumber || 0;
        const seenAnyBefore = !!repoState.lastIssueNumber;

        for (const issue of data) {
            const isPR = !!issue.pull_request;
            if (seenAnyBefore && issue.number > repoState.lastIssueNumber) {
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
                const hasMoreNew = data2.some(issue => issue.number > repoState.lastIssueNumber);
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
            baselineNotes.push(`${repo}: now tracking issues/PRs (${data.length} recent items checked)`);
        }

        repoState.lastIssueNumber = maxId;
        return items;
    }

export async function pollRepoStars(indicator, repo, state, baselineNotes) {
        state.repos ||= {};
        state.repos[repo] ||= {};
        const repoState = state.repos[repo];

        const data = await indicator._apiGet(`/repos/${indicator._encodeRepo(repo)}`);
        const count = data.stargazers_count;
        const items = [];
        const hadBaseline = typeof repoState.stars === 'number';

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

