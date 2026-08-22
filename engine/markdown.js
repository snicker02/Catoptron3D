// A very small Markdown subset renderer, written out because the project takes no dependencies
// and the help panel shows README.md directly rather than a separately-maintained copy that
// would drift. Covers exactly what the README uses: headings, paragraphs, lists, fenced code,
// pipe tables, rules, and inline code / bold / italic / links.
//
// Everything is escaped before any markup is inserted, so the README can contain < and & and
// GLSL snippets without becoming a markup-injection hazard.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s){
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(src){
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let list = null;                      // 'ul' | 'ol' | null

  const closeList = () => { if(list){ out.push('</' + list + '>'); list = null; } };

  while(i < lines.length){
    const ln = lines[i];

    // fenced code
    if(/^```/.test(ln)){
      closeList();
      const buf = [];
      i++;
      while(i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // pipe table: a header row followed by a |---|---| separator
    if(/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])){
      closeList();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while(i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') +
               '</tr></thead><tbody>' +
               rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
               '</tbody></table>');
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(ln);
    if(h){ closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }

    if(/^\s*(---|___|\*\*\*)\s*$/.test(ln)){ closeList(); out.push('<hr>'); i++; continue; }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(ln);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(ln);
    if(ul || ol){
      const want = ul ? 'ul' : 'ol';
      if(list !== want){ closeList(); out.push('<' + want + '>'); list = want; }
      // fold continuation lines into the same item
      let text = (ul || ol)[1];
      while(i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) &&
            !/^\s*([-*+]|\d+\.)\s/.test(lines[i + 1])){
        text += ' ' + lines[++i].trim();
      }
      out.push('<li>' + inline(text) + '</li>');
      i++;
      continue;
    }

    if(!ln.trim()){ closeList(); i++; continue; }

    // paragraph: absorb following non-blank, non-structural lines
    const buf = [ln.trim()];
    i++;
    while(i < lines.length && lines[i].trim() &&
          !/^(#{1,4}\s|```|\s*\||\s*[-*+]\s|\s*\d+\.\s|\s*(---|___|\*\*\*)\s*$)/.test(lines[i])){
      buf.push(lines[i++].trim());
    }
    closeList();
    out.push('<p>' + inline(buf.join(' ')) + '</p>');
  }
  closeList();
  return out.join('\n');
}
