// Faster drop-in for makefun-site 1.0.0: same output, byte for byte, built for speed.
// Reimplemented from the reference spec (README + lib code): front matter, slug rule,
// Markdown subset, template dialect, collections/tags/layouts/report. No dependencies.
// Optimisations: templates compiled once per case to straight-line JS render functions,
// Markdown rendered directly to strings (no token objects), ASCII fast path for slugify,
// per-case slug memo, escape fast path, array-push string building.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); };

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NEED_ESC = /[&<>"']/;
export function escapeHtml(text) {
  if (!NEED_ESC.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
function escChar(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

const NON_ASCII = /[^\x00-\x7f]/;
export function slugifyCached(cache, text) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  if (!NON_ASCII.test(text)) {
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const res = out === '' ? 'untitled' : out;
  cache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

function wordsOf(text) {
  // Count runs of non-whitespace (JS \s set) without allocating a match array.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n; i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i] === '---') { close = i; break; } }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    let blank = true;
    for (let j = 0; j < line.length; j++) { if (line[j] !== ' ' && line[j] !== '\t') { blank = false; break; } }
    if (blank || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const CONTINUED = /^ {2,}\S/;

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = line.slice(start, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) { if (line[i] !== ' ' && line[i] !== '\t') return false; }
  return true;
}
function headingOf(line) {
  let i = 0;
  while (i < line.length && line[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  if (line[i] !== ' ' && line[i] !== '\t') return null;
  const text = trimLine(line.slice(i + 1));
  return text === '' ? null : { depth: i, text };
}
function isHR(line) {
  const pre = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : -1;
  if (pre === -1) return false;
  for (let i = pre; i < line.length; i++) { if (line[i] !== ' ' && line[i] !== '\t') return false; }
  return true;
}
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}
function bulletOf(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

const INLINE_SPECIAL = /[\\`*\[]/g;
export function inline(s, env) {
  const out = [];
  const n = s.length;
  let last = 0;
  let i = 0;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const j = m.index;
    if (j > last) out.push(escapeHtml(s.slice(last, j)));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { out.push(s[j + 1]); i = j + 2; }
      else { out.push('\\'); i = j + 1; }
      last = i; INLINE_SPECIAL.lastIndex = i; continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>'); i = k + 1; }
      else { out.push('`'); i = j + 1; }
      last = i; INLINE_SPECIAL.lastIndex = i; continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out.push('<strong>', inline(s.slice(j + 2, k), env), '</strong>'); i = k + 2; }
        else { out.push('**'); i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out.push('<em>', inline(s.slice(j + 1, k), env), '</em>'); i = k + 1; }
        else { out.push('*'); i = j + 1; }
      }
      last = i; INLINE_SPECIAL.lastIndex = i; continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = q === -1 ? '' : s.slice(k + 2, q);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(j + 1, k), env), '</a>');
      i = q + 1;
    } else { out.push('['); i = j + 1; }
    last = i; INLINE_SPECIAL.lastIndex = i;
  }
  if (last < n) out.push(escapeHtml(s.slice(last)));
  return out.join('');
}

function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const c0 = line === '' ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) { if (isBlank(line)) { i++; continue; } }
    else if (c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42 && c0 !== 62 && !(c0 >= 48 && c0 <= 57)) {
      // Plain text line: cannot start any other block kind; go straight to paragraph.
      const body = [trimLine(line)];
      i++;
      while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
      const html = inline(body.join('\n'), env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
      continue;
    }
    const fenceLang = c0 === 96 ? fenceOpen(line) : null;
    if (fenceLang !== null) {
      const body = [];
      i++;
      while (i < total && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (let k = 0; k < body.length; k++) { code += escapeHtml(body[k]); code += '\n'; }
      const cls = fenceLang === '' ? '' : ` class="language-${escapeHtml(fenceLang)}"`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugifyCached(slugCache, heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < total && lines[i][0] === '>') { const l = lines[i++]; body.push(l[1] === ' ' ? l.slice(2) : l.slice(1)); }
      const kept = [];
      for (let k = 0; k < body.length; k++) { const t = trimLine(body[k]); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = ordered.num;
      while (i < total) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
export class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Lookup helpers are no longer used by generated code (it inlines lookups on the
// flat null-prototype vars object V), but kept for the generic long-path fallback.
function lkA(s, path) {
  let v = s[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
// textOf then escapeHtml in one pass (used for {{ }} vars).
function escText(v) {
  if (typeof v === 'string') {
    if (!NEED_ESC.test(v)) return v;
    return v.replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}
// Lookup on the flat vars object V (null prototype, so V[name] is undefined iff
// the name is unbound). Dotted steps keep the reference's own-property rule via
// a single shared temp _t, nested so each step assigns before it is read.
function lookupExpr(scopeVar, path) {
  let expr = `${scopeVar}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) {
    expr = `((_t=${expr}),_t===null||typeof _t!=='object'||!Object.hasOwn(_t,${JSON.stringify(path[k])})?undefined:_t[${JSON.stringify(path[k])}])`;
  }
  return expr;
}

// Free (unbound) first-names of a template's own nodes, not counting includes.
function collectFree(nodes, bound, out) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      if (n.kind === 'if') { collectFree(n.then, bound, out); if (n.else !== null) collectFree(n.else, bound, out); }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound); b2.add(n.name); b2.add('loop');
      collectFree(n.body, b2, out);
    }
  }
}
// Templates whose output depends only on site/tags/recent (and pure includes):
// rendered once per case and reused. Computed by fixpoint over parsed nodes.
function analysePure(nodesMap) {
  const pure = new Set();
  const depth = new Map();
  const includesOf = (nodes) => {
    const s = [];
    const walk = (ns) => { for (const n of ns) { if (n.kind === 'include') s.push(n.name); else if (n.kind === 'for') walk(n.body); else if (n.kind === 'if') { walk(n.then); if (n.else) walk(n.else); } } };
    walk(nodes);
    return s;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of nodesMap) {
      if (pure.has(name)) continue;
      const inc = includesOf(nodes);
      if (inc.some((t) => !pure.has(t))) continue;
      const free = new Set();
      collectFree(nodes, new Set(), free);
      let ok = true;
      for (const f of free) { if (f !== 'site' && f !== 'tags' && f !== 'recent') { ok = false; break; } }
      if (ok) { pure.add(name); changed = true; }
    }
  }
  const dep = (name, seen) => {
    if (depth.has(name)) return depth.get(name);
    if (seen.has(name)) return 99;
    seen.add(name);
    let d = 0;
    for (const t of includesOf(nodesMap.get(name))) d = Math.max(d, 1 + dep(t, seen));
    seen.delete(name);
    depth.set(name, d);
    return d;
  };
  for (const name of pure) dep(name, new Set());
  return { pure, depth };
}

function compileTemplate(name, nodes, templates, pureInfo, pureCache) {
  const lines = [];
  let counter = 0;
  const gen = (ns, scopeVar) => {
    for (const n of ns) {
      if (n.kind === 'text') lines.push(`out.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') lines.push(`out.push(escText(${lookupExpr(scopeVar, n.path)}));`);
      else if (n.kind === 'raw') lines.push(`out.push(textOf(${lookupExpr(scopeVar, n.path)}));`);
      else if (n.kind === 'if') {
        const cond = `${n.not ? '!' : ''}truthy(${lookupExpr(scopeVar, n.path)})`;
        if (n.else !== null) {
          lines.push(`if(${cond}){`);
          gen(n.then, scopeVar);
          lines.push('}else{');
          gen(n.else, scopeVar);
          lines.push('}');
        } else {
          lines.push(`if(${cond}){`);
          gen(n.then, scopeVar);
          lines.push('}');
        }
      } else if (n.kind === 'for') {
        const u = ++counter;
        const nm = JSON.stringify(n.name);
        lines.push(`{const _x${u}=${lookupExpr(scopeVar, n.path)};if(Array.isArray(_x${u})){const _sv${u}=V[${nm}];const _sh${u}=Object.hasOwn(V,${nm});const _sl${u}=V.loop;const _slh${u}=Object.hasOwn(V,'loop');for(let _k${u}=0;_k${u}<_x${u}.length;_k${u}++){V[${nm}]=_x${u}[_k${u}];V.loop={index:_k${u}+1,first:_k${u}===0,last:_k${u}===_x${u}.length-1,length:_x${u}.length};`);
        gen(n.body, scopeVar);
        lines.push(`}if(_sh${u})V[${nm}]=_sv${u};else delete V[${nm}];if(_slh${u})V.loop=_sl${u};else delete V.loop;}}`);
      } else if (n.kind === 'include') {
        const u = ++counter;
        if (pureInfo.pure.has(n.name)) {
          const d = pureInfo.depth.get(n.name) || 0;
          lines.push(`if(depth<8){const _p${u}=P.get(${JSON.stringify(n.name)});if(_p${u}!==undefined&&depth+${d}<8)out.push(_p${u});else{const _t${u}=T.get(${JSON.stringify(n.name)});if(_t${u}!==undefined)out.push(_t${u}(V,depth+1));}}`);
        } else {
          lines.push(`if(depth<8){const _t${u}=T.get(${JSON.stringify(n.name)});if(_t${u}!==undefined)out.push(_t${u}(V,depth+1));}`);
        }
      }
    }
  };
  gen(nodes, 'V');
  const factory = new Function('textOf', 'truthy', 'escText', 'T', 'P',
    `return function(V,depth){const out=[];let _t;${lines.join('')}return out.join('');}`);
  return factory(textOf, truthy, escText, templates, pureCache);
}

// ---------------------------------------------------------------- build
export function run(input) {
  const slugCache = new Map();
  const slugify = (t) => slugifyCached(slugCache, t);
  const templates = new Map();
  const pureCache = new Map();
  const report = [];
  const nodesMap = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try { nodesMap.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }
  const pureInfo = analysePure(nodesMap);
  for (const [name, nodes] of nodesMap) templates.set(name, compileTemplate(name, nodes, templates, pureInfo, pureCache));
  const base = input.site.base_url.replace(/\/+$/, '');
  // 1. sources, sorted by path
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }
  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data; s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) { if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; } }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // 4. markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html; s.toc = md.toc; s.excerpt = md.excerpt;
  }
  // 5. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => { p.newer = k === 0 ? null : posts[k - 1]; p.older = k === posts.length - 1 ? null : posts[k + 1]; });
  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const slug = slugify(tags[k]);
      if (seen.has(slug)) continue;
      seen.add(slug); out.push(tags[k]);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p); p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // 7. layouts
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '', excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // Render page-independent templates once per case (header/nav/footer when pure).
  const topV = Object.assign(Object.create(null), { site, tags: allTags, recent });
  for (const name of pureInfo.pure) {
    const fn = templates.get(name);
    if (fn !== undefined) pureCache.set(name, fn(topV, 0));
  }
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn(Object.assign(Object.create(null), { site, tags: allTags, recent }, vars), 0);
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = { ...card, slug: s.slug, content: s.html, toc: s.toc, newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
