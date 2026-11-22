import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { JiraRequirements, TestCase, TestRunResult } from './types';
import { validateTicketId } from './jira';

const execFileAsync = promisify(execFile);
const MAX_RETRIES = 3;

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trimEnd();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(`Git ${args[0]} failed: ${(failure.stderr || failure.message).trim().slice(0, 500)}`);
  }
}

function assertSafeRelativePath(root: string, relative: string): void {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Refusing path outside repository: ${relative}`);
  if (relative.startsWith('.mcp-cache/') || /(^|\/)(playwright-report|test-results|blob-report)\//.test(relative)) {
    throw new Error(`Refusing to stage generated cache or report file: ${relative}`);
  }
}

function parseGitHubRemote(remote: string): { owner: string; repo: string } {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error('Only GitHub remotes are supported by this server.');
  return { owner: match[1], repo: match[2] };
}

export async function currentBranch(root: string): Promise<string> {
  return git(root, ['branch', '--show-current']);
}

export async function createBranchAndPush(
  root: string,
  requestedId: string,
  files: string[],
  preservePaths: string[] = [],
): Promise<{ branch: string; commit: string; pushed: boolean; files: string[]; defaultBranch: string }> {
  const ticketId = validateTicketId(requestedId);
  if (!files.length) throw new Error(`No generated files were registered for ${ticketId}; refusing to create an empty commit.`);
  for (const file of files) assertSafeRelativePath(root, file);

  const status = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  const entries = status.split(/\r?\n/).filter(Boolean);
  const dirtyPaths = entries.map((line) => line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/'));
  const stagedPaths = entries
    .filter((line) => line.slice(0, 2) !== '??' && line[0] !== ' ')
    .map((line) => line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/'));
  const allowed = new Set(files.map((file) => file.replaceAll('\\', '/')));
  const preserved = new Set(preservePaths.map((file) => file.replaceAll('\\', '/')));
  const unexpected = dirtyPaths.filter((file) => !allowed.has(file) && !preserved.has(file));
  if (unexpected.length) {
    throw new Error(`Working tree changed during the pipeline: ${unexpected.join(', ')}.`);
  }

  const remote = await git(root, ['remote', 'get-url', 'origin']);
  parseGitHubRemote(remote);
  const headInfo = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const defaultBranch = headInfo.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/)?.[1];
  if (!defaultBranch) throw new Error('Could not determine the remote default branch from origin/HEAD.');

  await git(root, ['fetch', 'origin', `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
  const branch = `feature/${ticketId}-automation`;
  const localBranches = await git(root, ['branch', '--list', branch]);
  const remoteBranches = await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (remoteBranches) {
    await git(root, ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  }
  const startingBranch = await currentBranch(root);
  let createdBranch = false;
  const branchBase = remoteBranches ? `origin/${branch}` : `origin/${defaultBranch}`;
  if (localBranches) {
    const localHead = await git(root, ['rev-parse', branch]);
    const remoteHead = await git(root, ['rev-parse', branchBase]);
    if (localHead !== remoteHead) {
      throw new Error(`Local branch ${branch} differs from ${branchBase}; refusing to overwrite or reset it.`);
    }
    const unexpectedStaged = stagedPaths.filter((file) => !allowed.has(file));
    if (unexpectedStaged.length) {
      throw new Error(`Refusing to commit staged changes outside this pipeline's generated files: ${unexpectedStaged.join(', ')}.`);
    }
    if (startingBranch !== branch) {
      if (stagedPaths.length) {
        throw new Error(`Refusing to switch branches with staged changes: ${stagedPaths.join(', ')}.`);
      }
      await git(root, ['checkout', branch]);
    }
  } else {
    if (stagedPaths.length) {
      throw new Error(`Refusing to switch branches with staged changes: ${stagedPaths.join(', ')}.`);
    }
    await git(root, ['checkout', '-b', branch, branchBase]);
    createdBranch = true;
  }

  const afterCheckout = (await git(root, ['status', '--porcelain', '--untracked-files=all']))
    .split(/\r?\n/).filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/'));
  const unexpectedAfterCheckout = afterCheckout.filter((file) => !allowed.has(file) && !preserved.has(file));
  if (unexpectedAfterCheckout.length) {
    if (createdBranch && startingBranch) await git(root, ['checkout', startingBranch]);
    throw new Error(`Branch checkout exposed unexpected changes: ${unexpectedAfterCheckout.join(', ')}.`);
  }

  for (const file of files) await git(root, ['add', '--', file]);
  const staged = (await git(root, ['diff', '--cached', '--name-only'])).split(/\r?\n/).filter(Boolean);
  if (!staged.length && remoteBranches) {
    return {
      branch,
      commit: await git(root, ['rev-parse', 'HEAD']),
      pushed: true,
      files: [...allowed],
      defaultBranch,
    };
  }
  if (!staged.length || staged.some((file) => !allowed.has(file.replaceAll('\\', '/')))) {
    throw new Error('Only files created or changed by this pipeline may be staged; refusing to commit.');
  }

  await git(root, [
    'commit',
    '-m',
    `${ticketId}: add automated tests`,
    '-m',
    'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
  ]);
  const commit = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['push', '-u', 'origin', branch]);
  return { branch, commit, pushed: true, files: staged, defaultBranch };
}

async function githubRequest<T>(url: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN to create a pull request.');
  let lastError = 'temporary server error';
  const attempts = method === 'GET' ? MAX_RETRIES : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const request: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(15_000),
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(body);
      }
      response = await fetch(url, {
        ...request,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'network request failed';
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      else if (method === 'POST') throw new Error('GitHub PR request outcome is unknown after a network error; check for an existing PR before retrying.');
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000)
        : 250 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      const responseText = await response.text();
      let apiMessage = responseText.slice(0, 400);
      if (responseText) {
        try {
          const body = JSON.parse(responseText) as { message?: unknown };
          if (typeof body.message === 'string') apiMessage = body.message.slice(0, 400);
        } catch {
          apiMessage = responseText.slice(0, 400);
        }
      }
      if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        throw new Error('GitHub API rate limit exceeded; wait for the rate-limit reset before retrying.');
      }
      if (response.status === 403 && response.headers.has('x-github-sso')) {
        throw new Error(`GitHub denied the request because the token needs organization SSO authorization: ${apiMessage}`);
      }
      if (response.status === 403 && method === 'POST' && new URL(url).pathname.endsWith('/pulls')) {
        throw new Error(
          `GitHub denied pull request creation (HTTP 403): ${apiMessage}. ` +
          'Grant the token Pull requests: write access (fine-grained token) or repo scope (classic token), and authorize it for organization SSO if required.',
        );
      }
      throw new Error(`GitHub API request failed with HTTP ${response.status}: ${apiMessage}.`);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new Error('GitHub returned invalid JSON.');
    }
  }
  throw new Error(`GitHub request failed after ${attempts} attempt(s): ${lastError}`);
}

export async function createPullRequest(
  root: string,
  requestedId: string,
  details: {
    requirements: JiraRequirements;
    cases: TestCase[];
    run: TestRunResult;
    branch: string;
    files: string[];
    defaultBranch: string;
  },
): Promise<{ url: string; number: number; title: string }> {
  const ticketId = validateTicketId(requestedId);
  const current = await currentBranch(root);
  if (current !== details.branch || current === details.defaultBranch) {
    throw new Error(`Current branch ${current || '(detached)'} does not match the ticket branch; refusing to open a PR.`);
  }
  if (details.run.status !== 'passed' || details.run.failed !== 0) {
    throw new Error('Tests have not passed; refusing to open a pull request.');
  }

  const remote = await git(root, ['remote', 'get-url', 'origin']);
  const { owner, repo } = parseGitHubRemote(remote);
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${details.branch}`, base: details.defaultBranch });
  const existing = await githubRequest<Array<{ html_url: string; number: number; title: string }>>(
    `${api}/pulls?${query}`, 'GET',
  );
  if (existing.length) {
    return { url: existing[0].html_url, number: existing[0].number, title: existing[0].title };
  }

  const title = `${ticketId}: Automated tests`;
  const testList = details.cases.map((testCase) => `- \`${testCase.id}\` (${testCase.category}): ${testCase.title}`).join('\n');
  const body = [
    `## Requirement summary\n${details.requirements.title}\n\n${details.requirements.description.slice(0, 4000)}`,
    `## Test cases\n${testList || '- No test cases were generated.'}`,
    `## Files changed\n${details.files.map((file) => `- \`${file}\``).join('\n')}`,
    `## Run result\n${details.run.status}: ${details.run.passed} passed, ${details.run.failed} failed.`,
  ].join('\n\n');
  const created = await githubRequest<{ html_url: string; number: number; title: string }>(
    `${api}/pulls`,
    'POST',
    { title, body, head: details.branch, base: details.defaultBranch },
  );
  return { url: created.html_url, number: created.number, title: created.title };
}
