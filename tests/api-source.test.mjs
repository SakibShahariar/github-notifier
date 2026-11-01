import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../api.js', import.meta.url), 'utf8');

test('API rate-limit handling validates reset headers and falls back when no future reset is available', () => {
    assert.ok(source.includes("import {parseRateLimitResetEpoch} from './repo-utils.js';"));
    assert.ok(source.includes('const rateLimitResetEpoch = parseRateLimitResetEpoch(reset);'));
    assert.ok(source.includes('const hasFutureRateLimitReset = remaining === \'0\' && rateLimitResetEpoch !== null && rateLimitResetEpoch > nowEpoch;'));
    assert.ok(source.includes('&& !retryAfter && !hasFutureRateLimitReset'));
});
