import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { BadRequestError } from './errors.js';

const MAX_RULES_BYTES = 200 * 1024;
const RULE_SECTION = '## 历史批复沉淀';

/**
 * Append a distilled rule under a dedicated section. Keeps the user's hand-written
 * content intact and makes it obvious which lines were machine-generated.
 */
export function appendRuleBlock(current: string, rule: string): string {
  const normalized = rule
    .trim()
    .replace(/^[-*]\s*/, '')
    .replace(/[。.\s]+$/, '')
    .trim();
  if (!normalized) return current;

  const line = `- ${normalized}`;
  const body = current.replace(/\s+$/, '');

  if (body.split('\n').some((item) => item.trim() === line)) return current;

  if (!body) return `${RULE_SECTION}\n\n${line}\n`;

  const sectionIndex = body.indexOf(RULE_SECTION);
  if (sectionIndex !== -1) {
    // Keep the generated rules inside their section even when the user has
    // hand-written sections after it.
    const nextHeading = body.indexOf('\n## ', sectionIndex + RULE_SECTION.length);
    if (nextHeading === -1) return `${body}\n${line}\n`;

    const before = body.slice(0, nextHeading).replace(/\s+$/, '');
    const after = body.slice(nextHeading).replace(/^\n+/, '');
    return `${before}\n${line}\n\n${after}`;
  }

  return `${body}\n\n${RULE_SECTION}\n\n${line}\n`;
}

/**
 * GLOBAL_RULES.md is the Meta-Agent's knowledge base. It lives on disk so it
 * can be edited from the web console without restarting the server.
 */
export class RulesStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  read(): { content: string; updatedAt: number } {
    try {
      const content = readFileSync(this.path, 'utf8');
      return { content, updatedAt: Math.floor(statSync(this.path).mtimeMs) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: '', updatedAt: 0 };
      }
      throw error;
    }
  }

  write(content: string): { content: string; updatedAt: number } {
    if (Buffer.byteLength(content, 'utf8') > MAX_RULES_BYTES) {
      throw new BadRequestError('GLOBAL_RULES.md is too large (max 200KB)', 'RULES_TOO_LARGE');
    }

    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, this.path);

    return this.read();
  }

  append(rule: string): { content: string; updatedAt: number } {
    return this.write(appendRuleBlock(this.read().content, rule));
  }
}
