// Live benchmark for #47/#7: real GitHub API requests through the actual
// runBoundedWorkers() scheduler used by the extension. Read-only GETs to public
// repos. Not run by CI (no .test.mjs suffix); requires GJS, libsecret, and a
// saved github-notifier token. Run with:
//   gjs --module tests/benchmark-live-github.mjs
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import {runBoundedWorkers} from '../bounded-workers.js';

const tokenProc = Gio.Subprocess.new(
    ['secret-tool', 'lookup', 'application', 'github-notifier@SakibShahariar', 'api-host', 'api.github.com'],
    Gio.SubprocessFlags.STDOUT_PIPE);
const [, tokenOut] = tokenProc.communicate_utf8(null, null);
const TOKEN = (tokenOut || '').trim();
if (!TOKEN) {
    print('No saved github-notifier token found in Secret Service; cannot run live benchmark.');
    process.exit(1);
}

const session = new Soup.Session({timeout: 15});
const BASE = 'https://api.github.com';

function get(path) {
    return new Promise((resolve, reject) => {
        const msg = new Soup.Message({method: 'GET', uri: GLib.Uri.parse(BASE + path, GLib.UriFlags.NONE)});
        msg.request_headers.append('Authorization', `Bearer ${TOKEN}`);
        msg.request_headers.append('Accept', 'application/vnd.github+json');
        msg.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
        msg.request_headers.append('User-Agent', 'github-notifier-benchmark');
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            try {
                const status = msg.get_status();
                const remaining = msg.response_headers.get_one('X-RateLimit-Remaining');
                session.send_and_read_finish(res);
                if (status < 200 || status >= 300) {
                    reject(new Error(`HTTP ${status} on ${path}`));
                    return;
                }
                resolve(remaining);
            } catch (e) {
                reject(e);
            }
        });
    });
}

const REPOS = [
    'torvalds/linux','gnome/gnome-shell','python/cpython','microsoft/vscode','facebook/react',
    'neovim/neovim','rust-lang/rust','golang/go','nodejs/node','kubernetes/kubernetes',
    'denoland/deno','electron/electron','home-assistant/core','ansible/ansible','django/django',
    'laravel/laravel','rails/rails','vercel/next.js','vuejs/core','sveltejs/svelte',
    'flutter/flutter','dart-lang/sdk','apache/spark','tensorflow/tensorflow','pytorch/pytorch',
    'grafana/grafana','prometheus/prometheus','hashicorp/terraform','elastic/elasticsearch','getsentry/sentry',
];

async function timed(repos, concurrency) {
    const start = Date.now();
    const results = await runBoundedWorkers(repos, concurrency, async repo => {
        const path = `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=20`;
        await get(path);
        return get(`/repos/${repo}`);
    });
    if (results.length !== repos.length)
        throw new Error('incomplete results');
    return (Date.now() - start) / 1000;
}

async function main() {
    print('Live GitHub benchmark · real API through runBoundedWorkers');
    print('repos | serial (1) | pool (3) | speedup | rate-limit remaining');
    for (const count of [3, 30]) {
        const repos = REPOS.slice(0, count);
        const serial = await timed(repos, 1);
        const pool = await timed(repos, 3);
        const remaining = await get('/rate_limit');
        print(`${String(count).padStart(5)} | ${(serial.toFixed(2) + 's').padStart(10)} | ${(pool.toFixed(2) + 's').padStart(8)} | ${(serial / pool).toFixed(2)}x | ${remaining}`);
    }
}

main().catch(e => {
    printError(e, 'live benchmark failed');
    process.exit(1);
});
