/**
 * A deliberately small, dependency-free XML reader.
 *
 * JUnit XML is written by dozens of tools and some of them are not strict
 * XML serialisers. This parser therefore accepts the useful subset (elements,
 * attributes, text, CDATA, comments, declarations and character entities) and
 * is forgiving about unknown named entities while still rejecting structurally
 * broken documents with a useful line/column error.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

export class XmlParseError extends Error {
  constructor(message, source, index, sourceName = '<xml>') {
    const { line, column } = positionAt(source, index);
    super(`${sourceName}:${line}:${column}: ${message}`);
    this.name = 'XmlParseError';
    this.line = line;
    this.column = column;
    this.sourceName = sourceName;
  }
}

function positionAt(source, index) {
  const safeIndex = Math.max(0, Math.min(index, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < safeIndex; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: safeIndex - lineStart + 1 };
}

export function localName(name) {
  if (typeof name !== 'string') return '';
  const colon = name.lastIndexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function isElement(node) {
  return Boolean(node) && node.type === 'element';
}

export function elementChildren(node, name = null) {
  if (!node || !Array.isArray(node.children)) return [];
  const wanted = name === null ? null : String(name).toLowerCase();
  return node.children.filter(
    (child) => isElement(child) && (wanted === null || localName(child.name).toLowerCase() === wanted),
  );
}

export function firstElementChild(node, name) {
  if (!node || !Array.isArray(node.children)) return null;
  const wanted = String(name).toLowerCase();
  for (const child of node.children) {
    if (isElement(child) && localName(child.name).toLowerCase() === wanted) return child;
  }
  return null;
}

export function getAttribute(node, name) {
  if (!node || !node.attrs) return undefined;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key === name) return value;
    if (localName(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function textContent(node) {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'cdata') return node.value;
  if (!Array.isArray(node.children)) return '';
  let out = '';
  for (const child of node.children) out += textContent(child);
  return out;
}

export function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9._-]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

export function parseXml(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('parseXml expects a string');
  const sourceName = options.sourceName || '<xml>';
  const document = {
    type: 'document',
    name: '#document',
    attrs: Object.create(null),
    children: [],
  };
  const stack = [document];
  const length = source.length;
  let index = 0;

  const current = () => stack[stack.length - 1];
  const fail = (message, at = index) => {
    throw new XmlParseError(message, source, at, sourceName);
  };

  const appendText = (raw, cdata = false) => {
    if (stack.length === 1) return;
    const value = cdata ? raw : decodeEntities(raw);
    if (value === '') return;
    if (!cdata && value.trim() === '') return;
    current().children.push({ type: cdata ? 'cdata' : 'text', value });
  };

  while (index < length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      appendText(source.slice(index));
      index = length;
      break;
    }
    if (open > index) appendText(source.slice(index, open));
    index = open;

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end === -1) fail('unterminated comment');
      index = end + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end === -1) fail('unterminated CDATA section');
      appendText(source.slice(index + 9, end), true);
      index = end + 3;
      continue;
    }

    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2);
      if (end === -1) fail('unterminated processing instruction');
      index = end + 2;
      continue;
    }

    if (source.startsWith('<!', index)) {
      // DOCTYPE / declarations. Skip internal subsets without trying to
      // resolve entities (which also avoids entity-expansion attacks).
      let cursor = index + 2;
      let quote = null;
      let bracketDepth = 0;
      let done = false;
      while (cursor < length) {
        const char = source[cursor];
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '[') {
          bracketDepth += 1;
        } else if (char === ']') {
          bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (char === '>' && bracketDepth === 0) {
          done = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!done) fail('unterminated declaration');
      index = cursor;
      continue;
    }

    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index + 2);
      if (end === -1) fail('unterminated closing tag');
      const rawName = source.slice(index + 2, end).trim();
      if (rawName === '') fail('empty closing tag', index);
      const name = rawName.split(/\s+/, 1)[0];
      if (stack.length === 1) fail(`unexpected closing tag </${name}>`, index);
      const node = current();
      if (node.name !== name) {
        fail(`closing tag </${name}> does not match <${node.name}>`, index);
      }
      stack.pop();
      index = end + 1;
      continue;
    }

    // Start tag.
    const start = parseStartTag(source, index, sourceName);
    const node = {
      type: 'element',
      name: start.name,
      attrs: start.attrs,
      children: [],
    };
    current().children.push(node);
    if (!start.selfClosing) stack.push(node);
    index = start.end;
  }

  if (stack.length > 1) {
    const unclosed = stack[stack.length - 1];
    fail(`unclosed tag <${unclosed.name}>`, length);
  }

  return document;
}

function parseStartTag(source, index, sourceName) {
  const fail = (message, at = index) => {
    throw new XmlParseError(message, source, at, sourceName);
  };
  let cursor = index + 1;
  const length = source.length;
  const nameStart = cursor;
  while (cursor < length && !/[\s/>]/.test(source[cursor])) cursor += 1;
  const name = source.slice(nameStart, cursor);
  if (!name) fail('empty tag name');
  if (name.startsWith('!') || name.startsWith('?')) fail(`unsupported markup <${name}>`);

  const attrs = Object.create(null);
  let selfClosing = false;

  while (cursor < length) {
    while (cursor < length && /\s/.test(source[cursor])) cursor += 1;
    if (cursor >= length) fail(`unterminated tag <${name}>`);

    if (source[cursor] === '>') {
      cursor += 1;
      break;
    }

    if (source[cursor] === '/') {
      if (source[cursor + 1] !== '>') fail(`expected '/>' in tag <${name}>`, cursor);
      selfClosing = true;
      cursor += 2;
      break;
    }

    const attrStart = cursor;
    while (cursor < length && !/[\s=/>]/.test(source[cursor])) cursor += 1;
    const attrName = source.slice(attrStart, cursor);
    if (!attrName) fail(`invalid attribute in tag <${name}>`, cursor);

    while (cursor < length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] === '=') {
      cursor += 1;
      while (cursor < length && /\s/.test(source[cursor])) cursor += 1;
      if (cursor >= length) fail(`unterminated attribute ${attrName}`, cursor);

      let value = '';
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < length && source[cursor] !== quote) cursor += 1;
        if (cursor >= length) fail(`unterminated attribute ${attrName}`, valueStart);
        value = source.slice(valueStart, cursor);
        cursor += 1;
      } else {
        // Not strictly XML, but several JUnit writers emit bare values.
        const valueStart = cursor;
        while (cursor < length && !/[\s/>]/.test(source[cursor])) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
      attrs[attrName] = decodeEntities(value);
    } else {
      // Valueless attributes are invalid XML, but accepting them is more
      // useful than refusing to read an otherwise usable report.
      attrs[attrName] = '';
    }
  }

  return { name, attrs, selfClosing, end: cursor };
}
