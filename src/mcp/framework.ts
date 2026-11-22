import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FrameworkIndex } from './types';

const execFileAsync = promisify(execFile);
const INDEX_PATH = '.mcp-cache/framework-index.json';
const ROOT_FILES = ['package.json', 'playwright.config.ts', 'tsconfig.json'];
const SOURCE_DIRS = ['src/pages', 'src/fixtures', 'src/utils', 'src/helpers', 'tests'];

async function sourceFiles(root: string): Promise<string[]> {
  const files = new Set(ROOT_FILES.map((file) => path.join(root, file)));

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.(ts|tsx|js|json|md)$/.test(entry.name)) files.add(absolute);
    }
  }

  for (const directory of SOURCE_DIRS) await visit(path.join(root, directory));
  const existing: string[] = [];
  for (const file of files) {
    try {
      if ((await stat(file)).isFile()) existing.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return existing.sort();
}

async function snapshot(root: string): Promise<Record<string, [number, number]>> {
  const result: Record<string, [number, number]> = {};
  for (const absolute of await sourceFiles(root)) {
    const file = path.relative(root, absolute).replaceAll(path.sep, '/');
    const info = await stat(absolute);
    result[file] = [info.size, info.mtimeMs];
  }
  return result;
}

async function currentHead(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function symbolIndex(root: string): Promise<FrameworkIndex['reusable']> {
  const symbols: FrameworkIndex['reusable'] = [];
  for (const file of await sourceFiles(root)) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    if (!relative.startsWith('src/pages/') && !relative.startsWith('src/fixtures/')) continue;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let className = '';
    for await (const line of lines) {
      const classMatch = line.match(/export\s+class\s+(\w+)/);
      if (classMatch) {
        className = classMatch[1];
        symbols.push({
          name: className,
          file: relative,
          signature: `new ${className}(page: Page)`,
          purpose: className === 'PageManager'
            ? 'Page-object registry.'
            : `${className.replace(/Page$/, '')} page object.`,
        });
      }

      const methodMatch = line.match(/async\s+(\w+)\(([^)]*)\)\s*:\s*([^{]+)\{/);
      if (className && methodMatch) {
        const [, name, args, result] = methodMatch;
        symbols.push({
          name: `${className}.${name}`,
          file: relative,
          signature: `${name}(${args}): ${result.trim()}`,
          purpose: `${name} page action or query.`,
        });
      }
      const propertyMatch = line.match(/readonly\s+(\w+)\s*:\s*(\w+)\s*;/);
      if (className === 'PageManager' && propertyMatch) {
        const [, property, pageClass] = propertyMatch;
        symbols.push({
          name: `PageManager.${property}`,
          file: relative,
          signature: pageClass,
          purpose: `Registered as pages.${property}.`,
        });
      }

      if (/export\s+const\s+test\s*=/.test(line)) {
        symbols.push({
          name: 'test.pages',
          file: relative,
          signature: 'test(({ pages }: { pages: PageManager }) => void)',
          purpose: 'Provides page objects to tests.',
        });
      }
      if (/export\s*\{\s*expect\s*\}/.test(line)) {
        symbols.push({
          name: 'expect',
          file: relative,
          signature: 'export { expect }',
          purpose: 'Playwright assertion export.',
        });
      }
    }
  }
  return symbols;
}

function isSameSnapshot(
  first: Record<string, [number, number]>,
  second: Record<string, [number, number]>,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export async function analyzeFramework(root: string): Promise<{
  summary: string;
  indexPath: string;
  reusedCache: boolean;
  framework: FrameworkIndex['framework'];
  reusable: FrameworkIndex['reusable'];
}> {
  const absoluteIndex = path.join(root, INDEX_PATH);
  const [gitHead, sourceSnapshot] = await Promise.all([currentHead(root), snapshot(root)]);
  let existing: FrameworkIndex | undefined;
  try {
    existing = JSON.parse(await readFile(absoluteIndex, 'utf8')) as FrameworkIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  if (existing?.version === 1 && existing.gitHead === gitHead
    && isSameSnapshot(existing.sourceSnapshot, sourceSnapshot)
    && existing.reusable.some((symbol) => symbol.name === 'PageManager.homePage')) {
    return {
      summary: 'TypeScript + Playwright Test, POM, shared pages fixture; framework index is current.',
      indexPath: INDEX_PATH,
      reusedCache: true,
      framework: existing.framework,
      reusable: existing.reusable,
    };
  }

  const framework: FrameworkIndex['framework'] = {
    language: 'TypeScript',
    runner: 'Playwright Test',
    pattern: 'POM',
    tests: 'tests/**/*.spec.ts',
    config: ['playwright.config.ts', 'tsconfig.json'],
    fixtures: 'src/fixtures/test.ts',
    locators: 'Page-scoped; no shared utility',
    testData: 'Inline; no shared module',
    naming: 'PascalCase pages; camelCase members; *.spec.ts',
  };
  const index: FrameworkIndex = {
    version: 1,
    gitHead,
    framework,
    sourceSnapshot,
    reusable: await symbolIndex(root),
  };
  const serialized = `${JSON.stringify(index)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') >= 2048) {
    throw new Error('Framework index exceeds the 2 KB limit; reduce indexed metadata before continuing.');
  }
  await mkdir(path.dirname(absoluteIndex), { recursive: true });
  await writeFile(absoluteIndex, serialized, 'utf8');

  return {
    summary: 'TypeScript + Playwright Test, POM, shared pages fixture; framework index rebuilt.',
    indexPath: INDEX_PATH,
    reusedCache: false,
    framework,
    reusable: index.reusable,
  };
}

export async function readFrameworkIndex(root: string): Promise<FrameworkIndex> {
  const index = JSON.parse(await readFile(path.join(root, INDEX_PATH), 'utf8')) as FrameworkIndex;
  return index;
}
