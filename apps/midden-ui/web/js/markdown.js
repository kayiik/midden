// Markdown for the assistant's replies and the workspace's Markdown files,
// built as DOM nodes. No text goes through an HTML parser, so HTML in the
// source shows as text. Links open http(s) and mailto addresses in a new tab;
// other targets, and images, show as text, so a reply can't make the page
// load anything. Every pattern is bounded, so a long or hostile text renders
// in time proportional to its length.

const MAX_DEPTH = 8;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK = /^\[([ xX])\][ \t]+/;
const DELIMITER = /^:?-+:?$/;
// One pattern for the inline constructs: at a position, the first that
// matches wins.
const INLINE = new RegExp([
  String.raw`\\(?<escaped>[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])`,
  String.raw`(?<!\x60)(?<tick>\x60+)(?!\x60)(?<code>[\s\S]{1,1000}?)(?<!\x60)\k<tick>(?!\x60)`,
  String.raw`!\[(?<alt>[^\[\]\n]{0,500})\]\(\s*<?(?<src>(?:[^\s()<>]|\([^\s()<>]*\)){1,2000})>?(?:\s+"[^"\n]{0,500}")?\s*\)`,
  String.raw`\[(?<label>[^\[\]\n]{1,500})\]\(\s*<?(?<href>(?:[^\s()<>]|\([^\s()<>]*\)){1,2000})>?(?:\s+"[^"\n]{0,500}")?\s*\)`,
  String.raw`<(?<auto>(?:https?:\/\/|mailto:)[^\s<>]{1,2000})>`,
  String.raw`(?<![\p{L}\p{N}_\/])(?<bare>https?:\/\/[^\s<>"\x60]{1,2000})`,
  String.raw`\*\*\*(?![\s*])(?<strongEm>[^\n]{0,500}?[^\s*])\*\*\*`,
  String.raw`\*\*(?![\s*])(?<strong>[^\n]{0,500}?[^\s])\*\*`,
  String.raw`(?<![\p{L}\p{N}_])__(?![\s_])(?<strongU>[^\n]{0,500}?[^\s])__(?![\p{L}\p{N}_])`,
  String.raw`\*(?![\s*])(?<em>[^\n]{0,500}?[^\s*])\*`,
  String.raw`(?<![\p{L}\p{N}_])_(?![\s_])(?<emU>[^\n]{0,500}?[^\s_])_(?![\p{L}\p{N}_])`,
  String.raw`~~(?![\s~])(?<strike>[^\n]{0,500}?[^\s~])~~`,
].join("|"), "gu");

// renderMarkdown replaces the contents of container with text, formatted.
export function renderMarkdown(text, container) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n")
    .map(line => line.replace(/^[ \t]+/, space => space.replace(/\t/g, "    ")));
  container.replaceChildren();
  blocks(lines, container, 0);
  return container;
}

// markdown returns text, formatted, in a new element of class "md".
export function markdown(text) {
  const box = document.createElement("div");
  box.className = "md";
  return renderMarkdown(text, box);
}

function blocks(lines, parent, depth) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let match;
    if (!line.trim()) i++;
    else if (depth > MAX_DEPTH) i = paragraph(lines, i, parent);
    else if ((match = fence(line))) i = fenced(lines, i, match, parent);
    else if ((match = HEADING.exec(line))) { parent.append(inlined(`h${Math.min(6, match[1].length + 2)}`, match[2] || "")); i++; }
    else if (RULE.test(line)) { parent.append(document.createElement("hr")); i++; }
    else if (QUOTE.test(line)) i = quote(lines, i, parent, depth);
    else if (ITEM.test(line)) i = list(lines, i, parent, depth);
    else if (tableStart(line, lines[i + 1])) i = table(lines, i, parent);
    else i = paragraph(lines, i, parent);
  }
}

// interrupts reports whether line starts a block that ends a paragraph. As in
// CommonMark, a list does when its first item has text and, if numbered,
// starts at 1.
function interrupts(line, next) {
  if (fence(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || tableStart(line, next)) return true;
  const item = ITEM.exec(line);
  return !!item && !!item[3]?.trim() && (!/\d/.test(item[2]) || /^1[.)]$/.test(item[2]));
}

// paragraph keeps the line breaks of its source.
function paragraph(lines, i, parent) {
  const text = [lines[i].trim()];
  for (i++; i < lines.length && lines[i].trim() && !interrupts(lines[i], lines[i + 1]); i++) text.push(lines[i].trim());
  parent.append(inlined("p", text.join("\n")));
  return i;
}

function fence(line) {
  const match = FENCE.exec(line);
  return match && !(match[1][0] === "`" && match[2].includes("`")) ? match : null;
}

// fenced ends at its closing fence, or at the end of the text while a reply
// is still arriving.
function fenced(lines, i, match, parent) {
  const marker = match[1], indent = leading(lines[i]);
  const closing = new RegExp("^ {0,3}" + (marker[0] === "~" ? "~" : "\\x60") + "{" + marker.length + ",}[ \\t]*$");
  const body = [];
  for (i++; i < lines.length && !closing.test(lines[i]); i++) body.push(lines[i].slice(Math.min(indent, leading(lines[i]))));
  const pre = document.createElement("pre"), code = document.createElement("code");
  code.textContent = body.join("\n");
  pre.append(code);
  parent.append(pre);
  return i + 1;
}

function quote(lines, i, parent, depth) {
  const inner = [];
  for (let match; i < lines.length && (match = QUOTE.exec(lines[i])); i++) inner.push(match[1]);
  const box = document.createElement("blockquote");
  blocks(inner, box, depth + 1);
  parent.append(box);
  return i;
}

// list reads items of one kind at one indentation. A line indented further
// belongs to the item above it, so nested lists come from rendering an item's
// lines as blocks of their own.
function list(lines, i, parent, depth) {
  const first = ITEM.exec(lines[i]), indent = first[1].length, ordered = /\d/.test(first[2]);
  const element = document.createElement(ordered ? "ol" : "ul");
  if (ordered && Number.parseInt(first[2], 10) !== 1) element.start = Number.parseInt(first[2], 10);
  for (;;) {
    const match = ITEM.exec(lines[i]), content = indent + match[2].length + 1, body = [match[3] || ""];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        const next = filled(lines, i);
        if (next === lines.length || leading(lines[next]) <= indent) break;
        while (i < next) { body.push(""); i++; }
      } else if (leading(line) > indent) { body.push(line.slice(Math.min(leading(line), content))); i++; }
      else if (ITEM.test(line) || interrupts(line, lines[i + 1])) break;
      else { body.push(line.trim()); i++; }
    }
    element.append(listItem(body, depth));
    const next = filled(lines, i), following = next < lines.length && ITEM.exec(lines[next]);
    if (!following || following[1].length !== indent || /\d/.test(following[2]) !== ordered) break;
    i = next;
  }
  parent.append(element);
  return i;
}

function listItem(body, depth) {
  const item = document.createElement("li"), task = TASK.exec(body[0]);
  if (task) body[0] = body[0].slice(task[0].length);
  blocks(body, item, depth + 1);
  // A tight item shows its first paragraph without paragraph spacing.
  if (!body.some(line => !line.trim()) && item.firstChild?.nodeName === "P") item.firstChild.replaceWith(...item.firstChild.childNodes);
  if (task) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    box.defaultChecked = task[1] !== " ";
    item.className = "task";
    item.prepend(box);
  }
  return item;
}

function cells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const found = [];
  let cell = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && text[index + 1] === "|") { cell += "|"; index++; }
    else if (text[index] === "|") { found.push(cell.trim()); cell = ""; }
    else cell += text[index];
  }
  found.push(cell.trim());
  return found;
}

// aligns returns the column alignments when line is a table's delimiter row.
function aligns(line) {
  if (line === undefined || !line.includes("-") || !/^[ \t|:-]+$/.test(line)) return null;
  const found = cells(line);
  if (!found.every(cell => DELIMITER.test(cell)) || (found.length === 1 && !line.includes("|"))) return null;
  return found.map(cell => cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : cell.startsWith(":") ? "left" : "");
}

function tableStart(line, next) {
  if (!line.includes("|")) return false;
  const columns = aligns(next);
  return !!columns && cells(line).length === columns.length;
}

function table(lines, i, parent) {
  const columns = aligns(lines[i + 1]);
  const box = document.createElement("div"), grid = document.createElement("table");
  box.className = "table";
  const head = grid.createTHead().insertRow();
  cells(lines[i]).forEach((text, column) => head.append(cell("th", text, columns[column])));
  const body = grid.createTBody();
  for (i += 2; i < lines.length && lines[i].includes("|") && !interrupts(lines[i], lines[i + 1]); i++) {
    const row = body.insertRow(), values = cells(lines[i]);
    columns.forEach((align, column) => row.append(cell("td", values[column] ?? "", align)));
  }
  box.append(grid);
  parent.append(box);
  return i;
}

function cell(tag, text, align) {
  const element = inlined(tag, text);
  if (align) element.dataset.align = align;
  return element;
}

function filled(lines, i) {
  while (i < lines.length && !lines[i].trim()) i++;
  return i;
}

function leading(line) {
  return line.length - line.replace(/^ +/, "").length;
}

function inlined(tag, text) {
  const element = document.createElement(tag);
  inline(text, element, true, 0);
  return element;
}

// inline formats text into parent. Inside a link's label, links stay text.
function inline(text, parent, links, depth) {
  if (depth > MAX_DEPTH) { appendText(parent, text); return; }
  const pattern = new RegExp(INLINE);
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    appendText(parent, text.slice(last, match.index));
    last = pattern.lastIndex;
    const found = match.groups;
    if (found.escaped !== undefined) appendText(parent, found.escaped);
    else if (found.code !== undefined) parent.append(codeSpan(found.code));
    else if (found.src !== undefined) {
      // An image shows as a link to it.
      const url = links ? safeUrl(found.src) : "";
      if (url) parent.append(anchor(url, found.alt || found.src)); else appendText(parent, found.alt || found.src);
    } else if (found.href !== undefined) {
      const url = links ? safeUrl(found.href) : "";
      if (url) {
        const link = anchor(url, "");
        inline(found.label, link, false, depth + 1);
        parent.append(link);
      } else {
        inline(found.label, parent, links, depth + 1);
        if (found.href !== found.label) appendText(parent, ` (${found.href})`);
      }
    } else if (found.auto !== undefined) {
      const url = links ? safeUrl(found.auto) : "";
      if (url) parent.append(anchor(url, found.auto)); else appendText(parent, `<${found.auto}>`);
    } else if (found.bare !== undefined) {
      const kept = trimUrl(found.bare), url = links ? safeUrl(kept) : "";
      if (url) parent.append(anchor(url, kept)); else appendText(parent, kept);
      appendText(parent, found.bare.slice(kept.length));
    } else if (found.strongEm !== undefined) {
      const strong = document.createElement("strong");
      strong.append(styled("em", found.strongEm, links, depth));
      parent.append(strong);
    } else if (found.strong !== undefined || found.strongU !== undefined) parent.append(styled("strong", found.strong ?? found.strongU, links, depth));
    else if (found.em !== undefined || found.emU !== undefined) parent.append(styled("em", found.em ?? found.emU, links, depth));
    else parent.append(styled("del", found.strike, links, depth));
  }
  appendText(parent, text.slice(last));
}

function styled(tag, content, links, depth) {
  const element = document.createElement(tag);
  inline(content, element, links, depth + 1);
  return element;
}

function codeSpan(content) {
  let text = content.replace(/\n/g, " ");
  if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
  const code = document.createElement("code");
  code.textContent = text;
  return code;
}

function anchor(url, text) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  appendText(link, text);
  return link;
}

// safeUrl returns raw as an absolute http(s) or mailto address, or "".
function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

// trimUrl leaves out the punctuation that ends a sentence around a bare
// address, and a closing parenthesis it doesn't open.
function trimUrl(url) {
  const count = (text, character) => text.split(character).length - 1;
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1], kept = url.slice(0, end);
    if (".,;:!?'\"*_~".includes(last) || (last === ")" && count(kept, "(") < count(kept, ")"))) end--;
    else break;
  }
  return url.slice(0, end);
}

// appendText adds text with its line breaks.
function appendText(parent, text) {
  text.split("\n").forEach((part, index) => {
    if (index) parent.append(document.createElement("br"));
    if (part) parent.append(part);
  });
}
