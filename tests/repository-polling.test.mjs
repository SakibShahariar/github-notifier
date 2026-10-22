import assert from 'node:assert/strict';
import test from 'node:test';
import {pollRepoIssues, pollRepoStars} from '../repository-polling.js';

function indicatorWithResponses(responses) {
    const calls = [];
    return {
        calls,
        _apiGet: async path => {
            calls.push(path);
            if (!(path in responses)) throw new Error(`Unexpected API path: ${path}`);
            return responses[path];
        },
        _encodeRepo: repo => repo.split('/').map(encodeURIComponent).join('/'),
        _webBase: () => 'https://github.com',
    };
}

test('pollRepoIssues reports only issue numbers newer than the saved baseline', async () => {
    const repo = 'owner/repo';
    const indicator = indicatorWithResponses({
        '/repos/owner/repo/issues?state=open&sort=created&direction=desc&per_page=20': [
            {number: 12, title: 'New issue', html_url: 'https://github.com/owner/repo/issues/12', created_at: '2026-10-23T00:00:00Z'},
            {number: 9, title: 'Old issue', html_url: 'https://github.com/owner/repo/issues/9', created_at: '2026-10-20T00:00:00Z'},
        ],
    });
    const state = {repos: {[repo]: {lastIssueNumber: 10}}};
    const notes = [];
    const items = await pollRepoIssues(indicator, repo, state, notes);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'owner/repo-12');
    assert.equal(items[0].kind, 'issue');
    assert.equal(state.repos[repo].lastIssueNumber, 12);
    assert.deepEqual(notes, []);
});

test('pollRepoIssues records the initial baseline without creating false alerts', async () => {
    const repo = 'owner/repo';
    const indicator = indicatorWithResponses({
        '/repos/owner/repo/issues?state=open&sort=created&direction=desc&per_page=20': [
            {number: 4, title: 'Existing PR', pull_request: {}, html_url: 'https://github.com/owner/repo/pull/4', created_at: '2026-10-20T00:00:00Z'},
        ],
    });
    const state = {repos: {}};
    const notes = [];
    assert.deepEqual(await pollRepoIssues(indicator, repo, state, notes), []);
    assert.equal(state.repos[repo].lastIssueNumber, 4);
    assert.deepEqual(notes, ['owner/repo: now tracking issues/PRs (1 currently open)']);
});

test('pollRepoIssues emits a direct-link summary when a second page has more new items', async () => {
    const repo = 'owner/repo';
    const firstPage = Array.from({length: 20}, (_, i) => ({
        number: 120 - i,
        title: `Issue ${120 - i}`,
        html_url: `https://github.com/owner/repo/issues/${120 - i}`,
        created_at: '2026-10-23T00:00:00Z',
    }));
    const indicator = indicatorWithResponses({
        '/repos/owner/repo/issues?state=open&sort=created&direction=desc&per_page=20': firstPage,
        '/repos/owner/repo/issues?state=open&sort=created&direction=desc&per_page=20&page=2': [
            {number: 100, title: 'Older issue', html_url: 'https://github.com/owner/repo/issues/100', created_at: '2026-10-20T00:00:00Z'},
        ],
    });
    const state = {repos: {[repo]: {lastIssueNumber: 99}}};
    const items = await pollRepoIssues(indicator, repo, state, []);
    assert.equal(items.length, 21);
    assert.equal(items.at(-1).id, 'owner/repo-more-120');
    assert.equal(items.at(-1).url, 'https://github.com/owner/repo/issues');
    assert.equal(indicator.calls.length, 2);
});

test('pollRepoStars reports gains and establishes a silent first baseline', async () => {
    const repo = 'owner/repo';
    const indicator = indicatorWithResponses({'/repos/owner/repo': {stargazers_count: 8}});
    const state = {repos: {[repo]: {stars: 5}}};
    const items = await pollRepoStars(indicator, repo, state, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'owner/repo-stars-8');
    assert.equal(items[0].title, '+3 new stars (8 total)');
    assert.equal(items[0].url, 'https://github.com/owner/repo/stargazers');
    assert.equal(items[0].kind, 'star');
    assert.equal(typeof items[0].ts, 'string');
    assert.equal(state.repos[repo].stars, 8);

    const baselineState = {repos: {}};
    const notes = [];
    assert.deepEqual(await pollRepoStars(indicator, repo, baselineState, notes), []);
    assert.equal(baselineState.repos[repo].stars, 8);
    assert.deepEqual(notes, ['owner/repo: now tracking stars (currently 8)']);
});
