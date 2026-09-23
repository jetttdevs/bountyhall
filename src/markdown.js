// A small, safe Markdown renderer for the docs. It supports what the docs use:
// headings (with anchor ids), paragraphs, lists, fenced code, tables,
// blockquotes, rules, and inline code / bold / italics / links. Raw HTML is
// never passed through: everything is escaped, and links must be http(s),
// site-relative, anchors or mailto.
import { escapeHtml as e } from './util.js';

export const slugify = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const safeHref = (href) => (/^(https?:\/\/|\/|#|mailto:)/i.test(href) ? href : '#');

export function inline(text) {
  // pull out code spans first so nothing inside them is formatted
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = e(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const h = safeHref(href.replace(/&amp;/g, '&'));
    const external = /^https?:\/\//i.test(h);
    return `<a href="${e(h)}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${e(codes[Number(i)])}</code>`);
}

// Split a table row on | outside code spans; \| is a literal pipe.
function splitRow(row) {
  const cells = [''];
  let code = false;
  for (let k = 0; k < row.length; k++) {
    const ch = row[k];
    if (ch === '\\' && row[k + 1] === '|') { cells[cells.length - 1] += '|'; k++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { cells.push(''); continue; }
    cells[cells.length - 1] += ch;
  }
  return cells;
}

// Returns { html, title, headings: [{ level, text, id }] }.
export function render(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const used = new Map();
  let title = null;
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para.length = 0; } };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[1];
      out.push(`<div class="codeblock"><button class="copy" type="button" aria-label="Copy code">Copy</button><pre><code${lang ? ` class="lang-${e(lang)}"` : ''}>${e(body.join('\n'))}</code></pre></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      const text = h[2].trim();
      let id = slugify(text) || 'section';
      const n = used.get(id) || 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (level === 1 && !title) title = text;
      else headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(text)}${level > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ''}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^---+\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      const tone = body[0]?.match(/^\*\*(Note|Warning|Tip)\*\*/i)?.[1]?.toLowerCase() || 'note';
      out.push(`<blockquote class="callout ${tone}">${render(body.join('\n')).html}</blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flush();
      const cells = (l) => splitRow(l.trim().replace(/^\||\|$/g, '')).map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) { items.push(m[3]); i++; continue; }
        // continuation line of the previous item
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join('\n'), title, headings };
}
