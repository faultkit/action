import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubApiError, pullRequestNumber, upsertComment } from '../src/github.js';

const MARKER = '<!-- faultkit-resilience-report -->';

function fakeGitHub(comments = [], status = null) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method ?? 'GET';
    calls.push({ method, path: `${u.pathname}${u.search}`, auth: opts.headers?.Authorization });
    if (status) return new Response('{}', { status });
    if (method === 'GET') {
      const page = Number(u.searchParams.get('page'));
      return Response.json(comments.slice((page - 1) * 100, page * 100));
    }
    const { body } = JSON.parse(opts.body);
    if (method === 'POST') {
      comments.push({ id: 9000 + comments.length, body, user: { login: 'github-actions[bot]', type: 'Bot' } });
      return Response.json(comments.at(-1), { status: 201 });
    }
    const found = comments.find((c) => c.id === Number(u.pathname.split('/').pop()));
    found.body = body;
    return Response.json(found);
  };
  return { fetchImpl, calls, comments };
}
const upsert = (gh, body = `${MARKER}\nreport`) =>
  upsertComment({ token: 'ghs_test', repository: 'acme/shop', prNumber: 7, body, marker: MARKER, fetchImpl: gh.fetchImpl });

test('the PR number comes from a pull_request payload', () => {
  assert.equal(pullRequestNumber({ pull_request: { number: 7 } }), 7);
  assert.equal(pullRequestNumber({ ref: 'refs/heads/main' }), null);
  assert.equal(pullRequestNumber(null), null);
});

test('the first run creates the comment', async () => {
  const gh = fakeGitHub([{ id: 1, body: 'LGTM' }]);
  assert.equal(await upsert(gh), 'created');
  assert.deepEqual(gh.calls.map((c) => `${c.method} ${c.path}`), [
    'GET /repos/acme/shop/issues/7/comments?per_page=100&page=1',
    'POST /repos/acme/shop/issues/7/comments',
  ]);
  assert.equal(gh.calls[0].auth, 'Bearer ghs_test');
});

test('a later run updates the marked comment, even on a later page', async () => {
  const comments = [...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` })), { id: 500, body: `${MARKER}\nold`, user: { login: 'github-actions[bot]', type: 'Bot' } }];
  const gh = fakeGitHub(comments);
  assert.equal(await upsert(gh, `${MARKER}\nnew`), 'updated');
  assert.equal(comments.find((c) => c.id === 500).body, `${MARKER}\nnew`);
  assert.equal(comments.length, 101);
  assert.equal(gh.calls.at(-1).path, '/repos/acme/shop/issues/comments/500');
});

test('an API refusal is a GitHubApiError that never carries the token', async () => {
  const gh = fakeGitHub([], 403);
  await assert.rejects(upsert(gh), (err) => err instanceof GitHubApiError && err.status === 403 && !err.message.includes('ghs_test'));
});

test('a marked comment written by a person is never overwritten', async () => {
  const gh = fakeGitHub([{ id: 1, body: `${MARKER}\n✅ Passed`, user: { login: 'mallory', type: 'User' } }]);
  assert.equal(await upsert(gh), 'created');
  assert.equal(gh.comments[0].body, `${MARKER}\n✅ Passed`);
});

test('a repository name with dot segments is refused', async () => {
  const fetchImpl = async () => { throw new Error('no request expected'); };
  for (const repository of ['../evil', 'acme/..', 'acme/.']) {
    await assert.rejects(
      upsertComment({ token: 't', repository, prNumber: 7, body: 'b', marker: MARKER, fetchImpl }),
      GitHubApiError, repository);
  }
});
