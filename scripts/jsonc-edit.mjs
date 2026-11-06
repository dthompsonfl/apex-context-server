/**
 * Minimal JSONC-aware structural editor. Preserves unrelated comments, whitespace and keys.
 * Edits only the selected property span, not a parse/stringify of the entire user file.
 */
function tokens(raw) {
  const result = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "/" && raw[i + 1] === "/") {
      i = raw.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated JSONC comment");
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      const start = i++;
      let escaped = false;
      while (i < raw.length) {
        const current = raw[i++];
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === '"') break;
      }
      const text = raw.slice(start, i);
      result.push({ value: JSON.parse(text), symbol: "string", start, end: i });
      continue;
    }
    if ("{}[]:,".includes(ch)) {
      result.push({ symbol: ch, start: i, end: ++i });
      continue;
    }
    const start = i;
    while (i < raw.length && !/\s|[,}\]]/.test(raw[i])) i++;
    if (i === start) throw new Error("Unexpected JSONC character");
    result.push({ symbol: "atom", start, end: i });
  }
  return result;
}
function tree(raw) {
  const t = tokens(raw);
  let i = 0;
  function parseValue() {
    const current = t[i];
    if (!current) throw new Error("Unexpected end of JSONC");
    if (current.symbol === "{") {
      i++;
      const fields = [];
      while (t[i] && t[i].symbol !== "}") {
        const key = t[i++];
        if (key.symbol !== "string" || t[i++]?.symbol !== ":") throw new Error("Malformed JSONC object");
        const value = parseValue();
        fields.push({ name: key.value, start: key.start, end: value.end, value });
        if (t[i]?.symbol === ",") i++;
        else if (t[i]?.symbol !== "}") throw new Error("Malformed JSONC comma");
      }
      if (!t[i]) throw new Error("Unterminated JSONC object");
      return { kind: "object", start: current.start, end: t[i++].end, fields };
    }
    if (current.symbol === "[") {
      i++;
      while (t[i] && t[i].symbol !== "]") {
        parseValue();
        if (t[i]?.symbol === ",") i++;
        else if (t[i]?.symbol !== "]") throw new Error("Malformed JSONC array");
      }
      if (!t[i]) throw new Error("Unterminated JSONC array");
      return { kind: "array", start: current.start, end: t[i++].end };
    }
    if (current.symbol === "string" || current.symbol === "atom") {
      i++;
      return { kind: "scalar", start: current.start, end: current.end };
    }
    throw new Error("Malformed JSONC value");
  }
  const result = parseValue();
  if (i !== t.length || result.kind !== "object") throw new Error("OpenCode config must be a JSON object");
  // Parse a comment-free view to confirm primitive values and schema are JSON-compatible.
  const cleaned = [...raw];
  const lexical = tokens(raw);
  const protectedRanges = lexical.filter(x => x.symbol === "string").map(x => [x.start, x.end]);
  let quote = false, escape = false, line = false, block = false;
  for (let pos = 0; pos < raw.length; pos++) {
    const c = raw[pos], n = raw[pos + 1];
    if (line) { if (c === "\n") line = false; else cleaned[pos] = " "; continue; }
    if (block) {
      if (c === "*" && n === "/") { cleaned[pos] = cleaned[pos + 1] = " "; pos++; block = false; }
      else if (c !== "\n") cleaned[pos] = " ";
      continue;
    }
    if (quote) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') { quote = true; continue; }
    if (c === "/" && n === "/") { cleaned[pos] = cleaned[pos + 1] = " "; pos++; line = true; continue; }
    if (c === "/" && n === "*") { cleaned[pos] = cleaned[pos + 1] = " "; pos++; block = true; continue; }
  }
  const noComments = cleaned.join("").replace(/,(\s*[}\]])/g, "$1");
  JSON.parse(noComments);
  return result;
}
function findObject(raw, path) {
  let node = tree(raw);
  for (const part of path) {
    const field = node.fields?.find(x => x.name === part);
    if (!field) return null;
    node = field.value;
    if (node.kind !== "object") throw new Error("Configuration key is not an object: " + part);
  }
  return node;
}
export function getJsoncValue(raw, path) {
  let node = tree(raw);
  for (const part of path) {
    const field = node.fields?.find(x => x.name === part);
    if (!field) return undefined;
    node = field.value;
  }
  const snippet = raw.slice(node.start, node.end);
  return JSON.parse(snippet.replace(/,(\s*[}\]])/g, "$1"));
}
export function hasJsoncProperty(raw, path) {
  if (path.length === 0) return true;
  const parent = findObject(raw, path.slice(0, -1));
  return Boolean(parent?.fields.find(x => x.name === path.at(-1)));
}
export function setJsoncValue(raw, path, value) {
  if (!path.length) throw new Error("Cannot overwrite entire JSONC configuration");
  const parent = findObject(raw, path.slice(0, -1));
  if (!parent) throw new Error("JSONC parent object missing");
  const key = path.at(-1);
  const field = parent.fields.find(x => x.name === key);
  const indent = raw.slice(raw.lastIndexOf("\n", parent.start) + 1, parent.start).match(/^\s*/)?.[0] ?? "";
  const childIndent = indent + "  ";
  const serialized = JSON.stringify(value, null, 2).replace(/\n/g, "\n" + childIndent);
  if (field) return raw.slice(0, field.value.start) + serialized + raw.slice(field.value.end);
  const close = parent.end - 1;
  const prefix = parent.fields.length && !/,\s*$/.test(raw.slice(parent.fields.at(-1).end, close)) ? "," : "";
  const addition = prefix + "\n" + childIndent + JSON.stringify(key) + ": " + serialized + "\n" + indent;
  return raw.slice(0, close) + addition + raw.slice(close);
}
export function deleteJsoncValue(raw, path) {
  const parent = findObject(raw, path.slice(0, -1));
  if (!parent) return raw;
  const index = parent.fields.findIndex(x => x.name === path.at(-1));
  if (index < 0) return raw;
  const field = parent.fields[index];
  if (index + 1 < parent.fields.length) {
    return raw.slice(0, field.start) + raw.slice(parent.fields[index + 1].start);
  }
  if (index > 0) {
    return raw.slice(0, parent.fields[index - 1].end) + raw.slice(field.end);
  }
  return raw.slice(0, field.start) + raw.slice(field.end);
}
export function configWithApex(raw, server, client = "v1") {
  const base = raw || "{}\n";
  if (client !== "v1" && client !== "v2") throw new Error("Unsupported OpenCode client");
  if (!hasJsoncProperty(base, ["mcp"])) {
    return setJsoncValue(base, ["mcp"], client === "v2"
      ? { servers: { "apex-context": server } }
      : { "apex-context": server });
  }
  if (client === "v2") {
    if (!hasJsoncProperty(base, ["mcp", "servers"])) {
      return setJsoncValue(base, ["mcp", "servers"], { "apex-context": server });
    }
    return setJsoncValue(base, ["mcp", "servers", "apex-context"], server);
  }
  return setJsoncValue(base, ["mcp", "apex-context"], server);
}

export function configWithoutApex(raw, createdMcp, client = "v1") {
  const prefix = client === "v2" ? ["mcp", "servers"] : ["mcp"];
  const full = [...prefix, "apex-context"];
  if (!hasJsoncProperty(raw, full)) return raw;
  let next = deleteJsoncValue(raw, full);
  if (client === "v2" && findObject(next, prefix)?.fields.length === 0) {
    next = deleteJsoncValue(next, prefix);
  }
  if (createdMcp && findObject(next, ["mcp"])?.fields.length === 0) next = deleteJsoncValue(next, ["mcp"]);
  return next;
}
