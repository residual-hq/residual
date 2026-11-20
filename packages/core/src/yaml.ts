/**
 * Small YAML subset reader for Residual settings files.
 * Supports block mappings, `-` arrays, scalars, and `#` comments.
 * Not a general-purpose YAML implementation.
 */

export class YamlParseError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = "YamlParseError";
    this.line = line;
  }
}

type Line = {
  no: number;
  indent: number;
  text: string;
};

function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return text.slice(0, i).trimEnd();
  }
  return text;
}

function parseNumber(text: string): number | undefined {
  if (/^0\d+$/.test(text)) return undefined;
  if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)
    && !/^[+-]?\.\d+(?:[eE][+-]?\d+)?$/.test(text)) {
    return undefined;
  }
  const num = Number(text);
  return Number.isFinite(num) ? num : undefined;
}

function parseScalar(text: string): unknown {
  if (text === "null" || text === "~" || text === "") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  const num = parseNumber(text);
  if (num !== undefined) return num;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    const inner = text.slice(1, -1);
    if (text.startsWith('"')) return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    return inner.replace(/''/g, "'");
  }
  return text;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const stripped = stripComment(raw);
    if (stripped.trim() === "") return;
    const indent = stripped.match(/^ */)?.[0].length ?? 0;
    if (stripped.includes("\t")) {
      throw new YamlParseError("tabs are not allowed in residual settings YAML", index + 1);
    }
    lines.push({ no: index + 1, indent, text: stripped.slice(indent) });
  });
  return lines;
}

function parseBlock(lines: Line[], start: number, minIndent: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: null, next: start };
  const first = lines[start];
  if (first === undefined) return { value: null, next: start };
  if (first.indent < minIndent) return { value: null, next: start };
  if (first.text.startsWith("- ")) return parseArray(lines, start, first.indent);
  return parseMap(lines, start, first.indent);
}

function parseMap(lines: Line[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const result: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlParseError("unexpected indentation", line.no);
    }
    if (line.text.startsWith("- ")) {
      throw new YamlParseError("expected a mapping entry", line.no);
    }
    const colon = line.text.indexOf(":");
    if (colon < 0) throw new YamlParseError("expected 'key: value'", line.no);
    const key = line.text.slice(0, colon).trim();
    if (key.length === 0) throw new YamlParseError("empty key", line.no);
    const rest = line.text.slice(colon + 1).trim();
    if (rest.length > 0 && rest !== "|" && rest !== ">") {
      result[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    const next = lines[i + 1];
    if (!next || next.indent <= indent) {
      result[key] = null;
      i += 1;
      continue;
    }
    const child = parseBlock(lines, i + 1, indent + 1);
    result[key] = child.value;
    i = child.next;
  }
  return { value: result, next: i };
}

function parseArray(lines: Line[], start: number, indent: number): { value: unknown[]; next: number } {
  const result: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlParseError("unexpected indentation", line.no);
    if (!line.text.startsWith("- ")) throw new YamlParseError("expected a sequence entry", line.no);
    const rest = line.text.slice(2).trim();
    if (rest.length === 0) {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        result.push(null);
        i += 1;
        continue;
      }
      const child = parseBlock(lines, i + 1, indent + 1);
      result.push(child.value);
      i = child.next;
      continue;
    }
    // `- key:` with no inline value: the value is the following indented block
    // (a nested sequence or mapping). This is the shape of a DSH cordis patch.
    const onlyKey = rest.match(/^([^:]+):\s*$/);
    if (onlyKey) {
      const key = onlyKey[1]?.trim() ?? "";
      if (key.length === 0) throw new YamlParseError("empty key", line.no);
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        result.push({ [key]: null });
        i += 1;
        continue;
      }
      const child = parseBlock(lines, i + 1, indent + 1);
      result.push({ [key]: child.value });
      i = child.next;
      continue;
    }
    if (rest.includes(":") && !(rest.startsWith('"') || rest.startsWith("'"))) {
      // Inline mapping on the dash line, with optional nested indented fields.
      const fake: Line = { no: line.no, indent: indent + 2, text: rest };
      const restLines = [fake];
      let j = i + 1;
      while (j < lines.length) {
        const nested = lines[j];
        if (nested === undefined || nested.indent <= indent || nested.text.startsWith("- ")) break;
        restLines.push(nested);
        j += 1;
      }
      const child = parseMap(restLines, 0, indent + 2);
      result.push(child.value);
      i = j;
      continue;
    }
    result.push(parseScalar(rest));
    i += 1;
  }
  return { value: result, next: i };
}

export function parseYaml(text: string): unknown {
  const lines = splitLines(text);
  const first = lines[0];
  if (first === undefined) return {};
  const parsed = parseBlock(lines, 0, first.indent);
  if (parsed.next !== lines.length) {
    throw new YamlParseError("unexpected trailing content", lines[parsed.next]?.no);
  }
  return parsed.value;
}
