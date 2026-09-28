// Reads .faultkit/values.md: the business value and the outcomes a team says
// must never happen. The grammar and every error message match parse_values in
// faultkit/skills run_faultkit.py; test/fixtures/values/ is the shared contract.
// Change them together or not at all.

import fs from 'node:fs';
import path from 'node:path';
import { inside } from './manifest.js';

export class ValuesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValuesError';
  }
}

export const INFERRED_MARKER = '<!-- inferred by faultkit; not declared by a person -->';
// The s flag lets "." match U+2028/U+2029 inside a line, as Python's does.
const OUTCOME_LINE = /^- (UO-\d+): (.+)$/s;
const FRONTMATTER_KEY = /^([A-Za-z_][\w-]*):(.*)$/s;
const FRONTMATTER_ITEM = /^\s*- (.+)$/s;
const SECTIONS = new Map([
  ['business value', 'Business value'],
  ['unacceptable outcomes', 'Unacceptable outcomes'],
  ['out of scope', 'Out of scope'],
]);

/** Each line with its HTML comments removed, and the 1-based line of a comment left open. */
function uncomment(lines) {
  const out = [];
  let inside = false;
  let opened = null;
  lines.forEach((line, i) => {
    let kept = '';
    let rest = line;
    while (rest) {
      if (inside) {
        const end = rest.indexOf('-->');
        if (end < 0) rest = '';
        else [rest, inside] = [rest.slice(end + 3), false];
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) [kept, rest] = [kept + rest, ''];
        else {
          [kept, rest, inside] = [kept + rest.slice(0, start), rest.slice(start + 4), true];
          opened = i + 1;
        }
      }
    }
    out.push(kept);
  });
  return { lines: out, unclosed: inside ? opened : null };
}

function scalar(raw) {
  const s = raw.trim();
  return s.length >= 2 && s[0] === s[s.length - 1] && `"'`.includes(s[0]) ? s.slice(1, -1) : s;
}

/** Optional frontmatter: its keys, the line of each key, and the index of the first line after it. */
function frontmatter(lines, source) {
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || lines[first].trim() !== '---') return { keys: new Map(), keyLines: new Map(), start: 0 };
  const keys = new Map();
  const keyLines = new Map();
  let key = null;
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return { keys, keyLines, start: i + 1 };
    if (!line.trim()) continue;
    const pair = FRONTMATTER_KEY.exec(line);
    const item = FRONTMATTER_ITEM.exec(line);
    if (pair) {
      key = pair[1];
      const raw = pair[2].trim();
      keyLines.set(key, i + 1);
      if (raw.startsWith('[') && raw.endsWith(']')) {
        keys.set(key, raw.slice(1, -1).split(',').filter((part) => part.trim()).map(scalar));
      } else {
        keys.set(key, raw ? scalar(raw) : []);
      }
    } else if (item && key !== null && Array.isArray(keys.get(key))) {
      keys.get(key).push(scalar(item[1]));
    } else {
      throw new ValuesError(`${source}:${i + 1}: frontmatter line is not "key: value" or "- item"`);
    }
  }
  throw new ValuesError(`${source}:${first + 1}: frontmatter is not closed with ---`);
}

/** Parse a values file. Errors name the line, as `<source>:<line>: <message>`. */
export function parseValues(text, source = 'values.md') {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const raw = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const { lines, unclosed } = uncomment(raw);
  if (unclosed !== null) throw new ValuesError(`${source}:${unclosed}: comment is not closed with -->`);
  const { keys, keyLines, start } = frontmatter(lines, source);

  const sections = new Map();
  let current = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      current = SECTIONS.get(line.slice(3).trim().toLowerCase()) ?? null;
      if (current && sections.has(current)) throw new ValuesError(`${source}:${i + 1}: duplicate section "## ${current}"`);
      if (current) sections.set(current, { head: i + 1, body: [] });
    } else if (current) {
      sections.get(current).body.push([i + 1, line]);
    }
  }
  for (const name of ['Business value', 'Unacceptable outcomes']) {
    if (!sections.has(name)) throw new ValuesError(`${source}:1: missing "## ${name}" section`);
  }
  const value = sections.get('Business value');
  const businessValue = value.body.map(([, line]) => line).join('\n').trim();
  if (!businessValue) throw new ValuesError(`${source}:${value.head}: "## Business value" is empty`);

  const unacceptable = sections.get('Unacceptable outcomes');
  const outcomes = [];
  const seen = new Set();
  for (const [number, line] of unacceptable.body) {
    const match = OUTCOME_LINE.exec(line);
    if (!match || !match[2].trim()) continue;
    if (seen.has(match[1])) throw new ValuesError(`${source}:${number}: duplicate outcome id ${match[1]}`);
    seen.add(match[1]);
    outcomes.push({ id: match[1], text: match[2].trim() });
  }
  if (!outcomes.length) {
    throw new ValuesError(`${source}:${unacceptable.head}: "## Unacceptable outcomes" has no "- UO-n: text" line`);
  }
  const outOfScope = (sections.get('Out of scope')?.body ?? [])
    .map(([, line]) => line)
    .filter((line) => line.startsWith('- ') && line.slice(2).trim())
    .map((line) => line.slice(2).trim());
  for (const name of ['workflow', 'owner']) {
    if (Array.isArray(keys.get(name))) {
      throw new ValuesError(`${source}:${keyLines.get(name)}: frontmatter "${name}" must be a string`);
    }
  }
  const domains = keys.get('domains') ?? [];
  return {
    businessValue,
    outcomes,
    outOfScope,
    workflow: keys.get('workflow') ?? null,
    domains: typeof domains === 'string' ? [domains] : domains,
    owner: keys.get('owner') ?? null,
    inferred: raw[0].trim() === INFERRED_MARKER,
  };
}

/** Read and parse a values file; errors name it as `source`. */
export function loadValues(file, source = file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ValuesError(`cannot read ${source}: ${err.code ?? err.message}`);
  }
  return parseValues(text, source);
}

/**
 * The values file, as run_faultkit.py finds it: the `values` input, else the
 * manifest's "values", which must stay inside the repository, symlinks
 * included, else .faultkit/values.md. `exists` is false when that file is
 * missing.
 */
export function resolveValuesPath({ workspace, input, manifestValues }) {
  let file;
  if (input) file = path.resolve(workspace, input);
  else if (manifestValues) {
    file = path.resolve(workspace, manifestValues);
    const outside = !inside(workspace, file) ||
      (fs.existsSync(file) && !inside(fs.realpathSync(workspace), fs.realpathSync(file)));
    if (outside) throw new ValuesError(`"values" ${manifestValues} must stay inside the repository`);
  } else file = path.join(workspace, '.faultkit', 'values.md');
  return { file, exists: fs.existsSync(file) };
}

/**
 * Check every invariant's outcome against the values file: an outcome with no
 * file is a dangling reference, and one the file doesn't declare is an error.
 */
export function checkOutcomes(invariants, values, valuesPath) {
  const linked = invariants.filter((inv) => inv.outcome);
  if (!values) {
    if (linked.length) {
      const where = valuesPath ? ` at ${valuesPath}` : '';
      throw new ValuesError(
        `dangling outcome reference: ${linked[0].id} names ${linked[0].outcome}, but no values file was found${where}`,
      );
    }
    return;
  }
  const declared = new Set(values.outcomes.map((o) => o.id));
  for (const inv of linked) {
    if (!declared.has(inv.outcome)) throw new ValuesError(`${inv.id}: outcome ${inv.outcome} is not declared in ${valuesPath}`);
  }
}
