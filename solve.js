// A fast drop-in for makefun-site 1.0.0.
// Same answers, byte for byte, built from the published semantics:
// strict front matter, the template dialect, the Markdown subset,
// the slug rule and the build report. Speed comes from bulk text
// handling (no per-character escaping), direct Markdown rendering
// (no token objects), cached slugs and link targets, cards computed
// once per page, and templates compiled to plain JavaScript that
// appends to an array instead of walking a node tree per render.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const ESCAPABLE = '\\`*_[]()#+-.!>';
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

// ---------- text helpers ----------

const ESC_RE = /[&<>"']/;
const ESC_G = /[&<>"']/g;
const ESC_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  if (!ESC_RE.test(s)) return s;
  return s.replace(ESC_G, (c) => ESC_ENT[c]);
}

function et(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) { if (i) out += ', '; out += txt(v[i]); }
    return out;
  }
  return '';
}

function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i) s += ', '; s += txt(v[i]); }
    return s;
  }
  return '';
}

function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Second and later path segments: own property of an object, else undefined.
function g2(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else ws = c === 160 || c === 1680 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

function slugSlow(plain) {
  let out = '';
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
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const NONASCII_RE = /[^\x00-\x7F]/;
function slugOf(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NONASCII_RE.test(text)) {
    // ASCII: lower, runs of non-alphanumerics become one '-', trim, cut to 64.
    out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else out = slugSlow(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) { n++; out = slug + '-' + n; }
  taken.add(out);
  return out;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}

// ---------- front matter ----------

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugVal(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (c === 45) { if (prevDash) return false; prevDash = true; }
    else if (alnum) prevDash = false;
    else return false;
  }
  return !prevDash;
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    let y = 0, mo = 0, d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      if (ok) { y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10)); }
    }
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  if (key === 'slug') return isSlugVal(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
  return { error: 'unknown key "' + key + '"' };
}

// Parse front matter from text whose line ends are already "\n".
// Returns {data, body} or {error}. Body is the text after the closing line.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line, scanning line by line through the front matter only.
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let closeLine = -1;
  let closeEnd = -1;
  let lineNo = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') { closeLine = lineNo; closeEnd = nl === -1 ? text.length : nl + 1; break; }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = firstNl + 1;
  for (let i = 1; i < closeLine; i++) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl === -1 ? text.length : nl);
    pos = nl === -1 ? text.length : nl + 1;
    if (line === '' || /^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = line.slice(0, colon);
    let keyOk = key.length > 0;
    for (let k = 0; keyOk && k < key.length; k++) {
      const c = key.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) keyOk = false;
    }
    if (!keyOk) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let raw;
    if (colon + 1 >= line.length) raw = '';
    else if (line.charCodeAt(colon + 1) !== 32) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    else raw = line.slice(colon + 2);
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------- Markdown ----------

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

// Language of a fence-open line, or null. Fence-close is a line of ``` plus spaces/tabs.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line.charCodeAt(k))) k++;
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingInfo(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  let c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let p = n;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  if (p >= line.length) return null;
  let e = line.length;
  while (e > p && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === p) return null;
  return { depth: n, text: line.slice(p, e) };
}

function isHeading(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return false;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return false;
  let p = n;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  return p < line.length;
}

function isHr(line) {
  const dash = line.startsWith('---');
  const star = line.startsWith('***');
  if (!dash && !star) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return isHeading(line);
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedInfo(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k === 0 || k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { num: Number(line.slice(0, k)), text: line.slice(k + 2) };
}

function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  return c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

// Render inline markup of s, resolving links through linkFn(target).
// Plain runs are found with native indexOf scans; only the structural
// characters \\ ` * [ are ever handled in JavaScript.
const INLINE_PLAIN_RE = /[\\`*\[&<>"']/;
function inlineStr(s, linkFn) {
  if (!INLINE_PLAIN_RE.test(s)) return s;
  const out = [];
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const nb = s.indexOf('\\', i);
    const nq = s.indexOf('`', i);
    const ns = s.indexOf('*', i);
    const nl = s.indexOf('[', i);
    let j = -1;
    if (nb !== -1) j = nb;
    if (nq !== -1 && (j === -1 || nq < j)) j = nq;
    if (ns !== -1 && (j === -1 || ns < j)) j = ns;
    if (nl !== -1 && (j === -1 || nl < j)) j = nl;
    if (j === -1) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
        if (start < j) out.push(esc(s.slice(start, j)));
        const nx = s[j + 1];
        out.push(nx === '>' ? '&gt;' : nx);
        i = j + 2;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (start < j) out.push(esc(s.slice(start, j)));
        out.push('<code>' + esc(s.slice(j + 1, k)) + '</code>');
        i = k + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (start < j) out.push(esc(s.slice(start, j)));
          out.push('<strong>' + inlineStr(s.slice(j + 2, k), linkFn) + '</strong>');
          i = k + 2;
          start = i;
        } else i = j + 2;
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (start < j) out.push(esc(s.slice(start, j)));
          out.push('<em>' + inlineStr(s.slice(j + 1, k), linkFn) + '</em>');
          i = k + 1;
          start = i;
        } else i = j + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (start < j) out.push(esc(s.slice(start, j)));
      out.push('<a href="' + esc(linkFn(target)) + '">' + inlineStr(s.slice(j + 1, k), linkFn) + '</a>');
      i = m + 1;
      start = i;
    } else i = j + 1;
  }
  if (start < n) out.push(esc(s.slice(start)));
  return out.join('');
}

// Render one body to {html, toc, excerpt}. st holds per-run caches and link state.
function renderMarkdown(body, dir, st) {
  const lines = body.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const linkFn = (target) => resolveLink(target, dir, st);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const fenceLines = [];
      while (i < lines.length && !isFenceClose(lines[i])) { fenceLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      const cls = lang === '' ? '' : ' class="language-' + esc(lang) + '"';
      blocks.push('<pre><code' + cls + '>' + (fenceLines.length === 0 ? '' : esc(fenceLines.join('\n')) + '\n') + '</code></pre>');
      continue;
    }
    const h = headingInfo(line);
    if (h !== null) {
      const id = uniqueSlug(slugOf(h.text, st.slugCache), ids);
      const html = inlineStr(h.text, linkFn);
      blocks.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const raw = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        raw.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const q = [];
      for (let k = 0; k < raw.length; k++) { const t = trimLine(raw[k]); if (t !== '') q.push(t); }
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inlineStr(q.join('\n'), linkFn) + '</p>\n</blockquote>');
      continue;
    }
    const b = bulletText(line);
    const o = b === null ? orderedInfo(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const startNum = isOrdered ? o.num : 1;
      const items = [];
      while (i < lines.length) {
        let m = null;
        if (isOrdered) { const oi = orderedInfo(lines[i]); if (oi !== null) m = oi.text; }
        else { const bt = bulletText(lines[i]); if (bt !== null) m = bt; }
        if (m !== null) { items.push([trimLine(m)]); i++; }
        else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? '<ol start="' + startNum + '">' : '<' + tag + '>';
      let html = open + '\n';
      for (let k = 0; k < items.length; k++) html += '<li>' + inlineStr(items[k].join('\n'), linkFn) + '</li>\n';
      html += '</' + tag + '>';
      blocks.push(html);
      continue;
    }
    const bodyLines = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) { bodyLines.push(trimLine(lines[i])); i++; }
    const text = bodyLines.join('\n');
    const html = inlineStr(text, linkFn);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt };
}

function resolveLink(target, dir, st) {
  const key = st.curSource + '\n' + target;
  const hit = st.linkCache.get(key);
  if (hit !== undefined) {
    if (hit.broken !== null) st.broken.add(hit.broken);
    return hit.href;
  }
  let href;
  let broken = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
    href = target;
  } else {
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null && st.bySource.has(path)) href = st.bySource.get(path).url + frag;
    else if (path !== null && st.staticPaths.has(path)) href = st.base + '/' + path + frag;
    else { broken = 'broken-link ' + st.curSource + ' -> ' + target; href = target; }
  }
  st.linkCache.set(key, { href, broken });
  if (broken !== null) st.broken.add(broken);
  return href;
}

// ---------- Templates ----------

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function spacesOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const nxt = src[open + 1];
    if (nxt !== '{' && nxt !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (nxt === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spacesOnly(src.slice(lineStart, open)) && spacesOnly(src.slice(end, lineEnd));
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
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else !== null && parent.else !== undefined ? parent.else : parent.then);
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// Expression for a path read from scope variable sv.
function pathExpr(path, sv) {
  let e = sv + '.' + path[0];
  for (let k = 1; k < path.length; k++) e = 'g2(' + e + ',' + JSON.stringify(path[k]) + ')';
  return e;
}

function compileNodes(nodes, sv, ctr) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') { code += 'O.push(' + JSON.stringify(n.text) + ');'; continue; }
    if (n.kind === 'var') { code += 'O.push(et(' + pathExpr(n.path, sv) + '));'; continue; }
    if (n.kind === 'raw') { code += 'O.push(txt(' + pathExpr(n.path, sv) + '));'; continue; }
    if (n.kind === 'if') {
      const cond = (n.not ? '!' : '') + 'tr(' + pathExpr(n.path, sv) + ')';
      code += 'if(' + cond + '){' + compileNodes(n.then, sv, ctr) + '}';
      if (n.else !== null) code += 'else{' + compileNodes(n.else, sv, ctr) + '}';
      continue;
    }
    if (n.kind === 'for') {
      const id = ++ctr.n;
      const xs = '_a' + id, ix = '_i' + id, lp = '_l' + id, hn = '_h' + id, on = '_o' + id, hl = '_q' + id, ol = '_r' + id;
      const nm = JSON.stringify(n.name);
      code += 'const ' + xs + '=' + pathExpr(n.path, sv) + ';if(Array.isArray(' + xs + ')){const ' + hn + '=Object.hasOwn(' + sv + ',' + nm + ');const ' + on + '=' + sv + '[' + nm + '];const ' + hl + '=Object.hasOwn(' + sv + ',"loop");const ' + ol + '=' + sv + '.loop;const ' + lp + '={index:0,first:false,last:false,length:' + xs + '.length};for(let ' + ix + '=0;' + ix + '<' + xs + '.length;' + ix + '++){ ' + sv + '[' + nm + ']=' + xs + '[' + ix + '];' + sv + '.loop=' + lp + ';' + lp + '.index=' + ix + '+1;' + lp + '.first=' + ix + '===0;' + lp + '.last=' + ix + '===' + xs + '.length-1;' + compileNodes(n.body, sv, ctr) + '}if(' + hn + ')' + sv + '[' + nm + ']=' + on + ';else delete ' + sv + '[' + nm + '];if(' + hl + ')' + sv + '.loop=' + ol + ';else delete ' + sv + '.loop;}';
      continue;
    }
    if (n.kind === 'include') {
      const id = ++ctr.n;
      code += 'if(D<8){const _f' + id + '=T.get(' + JSON.stringify(n.name) + ');if(_f' + id + ')_f' + id + '(O,' + sv + ',D+1,T,et,txt,tr,g2);}';
      continue;
    }
  }
  return code;
}

function compileTemplate(nodes) {
  const body = compileNodes(nodes, 'S', { n: 0 });
  return new Function('O', 'S', 'D', 'T', 'et', 'txt', 'tr', 'g2', body);
}

// ---------- Build ----------

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const st = {
    base,
    slugCache: new Map(),
    linkCache: new Map(),
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
    curSource: '',
  };
  // 1. Sources, sorted by path in code-unit order; .md is a source, the rest static.
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  for (const f of statics) st.staticPaths.add(f.path);
  // 2. Front matter and the refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugOf(s.data.title, st.slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    st.bySource.set(s.path, s);
  }
  // 4. Markdown, links resolved.
  for (const s of kept) {
    st.curSource = s.path;
    const md = renderMarkdown(s.body, dirOf(s.path), st);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0)));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  // 6. Tags, grouped by slug, first spelling kept, ordered by count then slug.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const names = s.data.tags !== undefined ? s.data.tags : [];
    for (let i = 0; i < names.length; i++) {
      const slug = slugOf(names[i], st.slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(names[i]); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugOf(name, st.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const slug = slugOf(name, st.slugCache);
      const t = bySlug.get(slug);
      return t !== undefined ? t : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  // Cards once per page; pages reuse them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    const out = [];
    fn(out, scope, 0, templates, et, txt, tr, g2);
    return out.join('');
  };
  for (const s of kept) {
    const page = s.card;
    const pageObj = {
      title: page.title, url: page.url, date: page.date, date_long: page.date_long,
      summary: page.summary, excerpt: page.excerpt, reading_minutes: page.reading_minutes, tags: page.tags,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageObj });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }
  // 8. Report.
  const lines = [...report, ...st.broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
