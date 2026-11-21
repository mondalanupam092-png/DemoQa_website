import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JiraRequirements } from './types';

const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;

class JiraHttpError extends Error {
  constructor(readonly status: number) {
    super(`Jira API request failed with HTTP ${status}.`);
    this.name = 'JiraHttpError';
  }
}

export function validateTicketId(ticketId: string): string {
  const normalized = ticketId.trim().toUpperCase();
  if (!TICKET_PATTERN.test(normalized)) {
    throw new Error('Invalid Jira ticket ID. Expected a value such as KAN-4.');
  }
  return normalized;
}

export function jiraPlainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: unknown; content?: unknown };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  const type = (value as { type?: string }).type;
  const parts = node.content.map(jiraPlainText).filter(Boolean);
  if (type === 'heading') return `## ${parts.join('')}`;
  if (type === 'listItem') return `- ${parts.join('')}`;
  if (type === 'paragraph') return parts.join('');
  if (type === 'doc' || type === 'bulletList' || type === 'orderedList') return parts.join('\n');
  return parts.join('');
}

export function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split(/\r?\n/);
  const heading = /^\s{0,3}(?:#{1,6}\s*)?(?:acceptance criteria|acceptance tests|definition of done|ac)\s*:?\s*$/i;
  const nextHeading = /^\s{0,3}#{1,6}\s+\S/;
  const criteria: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const headingText = line.replace(/^\s{0,3}#{1,6}\s*/, '');
    const inline = headingText.match(/^\s*(?:acceptance criteria|acceptance tests|definition of done|ac)\s*:\s*(.+)$/i);
    if (inline) {
      inSection = true;
      criteria.push(inline[1].trim());
      continue;
    }
    if (heading.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && nextHeading.test(line)) break;
    if (!inSection) continue;
    const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim();
    if (text) criteria.push(text);
  }
  return criteria;
}

function valuesFromField(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(jiraPlainText).map((text) => text.trim()).filter(Boolean);
  const text = jiraPlainText(value).trim();
  return text ? text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()).filter(Boolean) : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jiraJson<T>(url: URL, token: string): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Network request failed.');
      if (attempt + 1 < MAX_RETRIES) await sleep(250 * 2 ** attempt);
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : 250 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new JiraHttpError(response.status);
    try {
      return await response.json() as T;
    } catch {
      throw new Error('Jira returned invalid JSON.');
    }
  }
  throw new Error(`Jira request failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? 'temporary server error'}`);
}

function requiredJiraConfig(): { base: URL; token: string } {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  const missing = [
    !baseUrl && 'JIRA_BASE_URL',
    !email && 'JIRA_EMAIL',
    !apiToken && 'JIRA_API_TOKEN',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing Jira environment variables: ${missing.join(', ')}.`);
  if (!baseUrl || !email || !apiToken) throw new Error('Jira environment variables are incomplete.');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('JIRA_BASE_URL must use HTTP or HTTPS.');
  const token = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return { base, token };
}

function issueUrl(base: URL, ticketId: string, fields: string): URL {
  const url = new URL(`rest/api/3/issue/${encodeURIComponent(ticketId)}`, `${base.href.replace(/\/+$/, '')}/`);
  url.searchParams.set('fields', fields);
  return url;
}

type JiraIssue = {
  fields?: Record<string, unknown> & {
    updated?: string;
    summary?: string;
    description?: unknown;
    labels?: string[];
    issuelinks?: Array<{
      inwardIssue?: { key?: string };
      outwardIssue?: { key?: string };
      type?: { name?: string };
    }>;
  };
};

async function readCache(root: string, ticketId: string, updated: string): Promise<JiraRequirements | undefined> {
  const updatedKey = Buffer.from(updated).toString('hex');
  try {
    const cached = JSON.parse(await readFile(path.join(root, '.mcp-cache', 'jira', `${ticketId}-${updatedKey}.json`), 'utf8')) as JiraRequirements;
    return cached.acceptanceCriteria.length ? cached : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export async function fetchJiraRequirements(root: string, requestedId: string): Promise<JiraRequirements> {
  const ticketId = validateTicketId(requestedId);
  const { base, token } = requiredJiraConfig();
  const statusIssue = await jiraJson<JiraIssue>(issueUrl(base, ticketId, 'updated'), token);
  const updated = statusIssue.fields?.updated;
  if (!updated) throw new Error(`Jira issue ${ticketId} did not include an updated timestamp.`);
  const cached = await readCache(root, ticketId, updated);
  if (cached?.updated === updated) return cached;

  const editMetaUrl = new URL(`rest/api/3/issue/${encodeURIComponent(ticketId)}/editmeta`, `${base.href.replace(/\/+$/, '')}/`);
  let editMeta: { fields?: Record<string, { name?: string }> } = {};
  try {
    editMeta = await jiraJson<{ fields?: Record<string, { name?: string }> }>(editMetaUrl, token);
  } catch (error) {
    if (!(error instanceof JiraHttpError) || ![403, 404].includes(error.status)) throw error;
  }
  const acceptanceField = Object.entries(editMeta.fields ?? {})
    .find(([, field]) => /acceptance criteria/i.test(field.name ?? ''))?.[0];
  const fields = ['summary', 'description', 'labels', 'issuelinks', 'updated', acceptanceField]
    .filter((field): field is string => Boolean(field))
    .join(',');
  const issue = await jiraJson<JiraIssue>(issueUrl(base, ticketId, fields), token);
  const data = issue.fields;
  if (!data?.summary || !data.updated) throw new Error(`Jira issue ${ticketId} is missing its summary or updated timestamp.`);
  const description = jiraPlainText(data.description).trim();
  const criteriaValue = acceptanceField ? valuesFromField(data[acceptanceField]) : [];
  const acceptanceCriteria = criteriaValue.length ? criteriaValue : extractAcceptanceCriteria(description);
  const links = (data.issuelinks ?? []).flatMap((link) => {
    const key = link.inwardIssue?.key ?? link.outwardIssue?.key;
    return key ? [`${key}${link.type?.name ? ` (${link.type.name})` : ''}`] : [];
  });
  const requirements: JiraRequirements = {
    ticketId,
    updated: data.updated,
    title: data.summary,
    description,
    acceptanceCriteria,
    labels: Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === 'string') : [],
    linkedIssues: links,
  };
  const cacheDirectory = path.join(root, '.mcp-cache', 'jira');
  await mkdir(cacheDirectory, { recursive: true });
  const updatedKey = Buffer.from(requirements.updated).toString('hex');
  await writeFile(path.join(cacheDirectory, `${ticketId}-${updatedKey}.json`), `${JSON.stringify(requirements, null, 2)}\n`, 'utf8');
  return requirements;
}
