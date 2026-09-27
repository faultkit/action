// The only GitHub mutation this action makes: one PR comment, found again by
// its marker and updated in place.

export class GitHubApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/** The pull request number in a workflow event payload, or null. */
export function pullRequestNumber(event) {
  const n = event?.pull_request?.number;
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function call(fetchImpl, token, method, url, body) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'faultkit-action',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new GitHubApiError(res.status, `GitHub API ${method} ${new URL(url).pathname} returned HTTP ${res.status}`);
  return res.json();
}

/** Update the comment carrying `marker`, or create it. */
export async function upsertComment({ token, repository, prNumber, body, marker, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w-]+\/(?!\.+$)[\w.-]+$/.test(repository ?? '')) throw new GitHubApiError(0, `not a repository name: ${repository}`);
  const base = `${apiUrl}/repos/${repository}`;
  for (let page = 1; page <= 30; page += 1) {
    const comments = await call(fetchImpl, token, 'GET', `${base}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    // Anyone can comment on a pull request; only a bot's marked comment is ours to update.
    const mine = comments.find((c) => c?.user?.type === 'Bot' && typeof c.body === 'string' && c.body.includes(marker));
    if (mine) {
      await call(fetchImpl, token, 'PATCH', `${base}/issues/comments/${mine.id}`, { body });
      return 'updated';
    }
    if (comments.length < 100) break;
  }
  await call(fetchImpl, token, 'POST', `${base}/issues/${prNumber}/comments`, { body });
  return 'created';
}
