import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

// Follow shipped imports, including lazy routes; unused prototypes are excluded.
const root = fileURLToPath(new URL("../src/", import.meta.url));
const dictionary = JSON.parse(await readFile(path.join(root, "i18n/zh-CN.json"), "utf8"));
const issues = new Set(), visited = new Set();
const parameters = text => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort().join(",");
for (const [key, value] of Object.entries(dictionary)) {
  if (typeof value !== "string" || parameters(key) !== parameters(value)) issues.add(`Invalid translation or parameters: ${key}`);
}
const presentationAttributes = new Set(["label", "title", "description", "placeholder", "hint", "detail", "inputLabel", "buttonLabel", "aria-label", "alt"]);
const identityAttributes = new Set(["value", "key", "id", "name", "className", "href", "to", "type", "role"]);
const brands = new Set(["CoLearnX", "neXt", "Stripe", "Google"]);
const translated = node => node?.type === "CallExpression" && node.callee.name === "t";
const humanText = text => /[a-z]/i.test(text) && !brands.has(text.trim());
function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "comments", "tokens"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node));
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}
async function resolveImport(file, source) {
  if (!source.startsWith(".")) return null;
  const base = path.resolve(path.dirname(file), source);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, path.join(base, "index.js")]) {
    if (!/\.(jsx|js)$/.test(candidate)) continue;
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Next extension. */ }
  }
  return null;
}
async function scan(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = await readFile(file, "utf8"), imports = [];
  const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
  const report = (node, message) => issues.add(`${path.relative(root, file)}:${node.loc.start.line}: ${message}`);
  const checkKey = (node, value) => { if (value.trim() && !Object.hasOwn(dictionary, value.trim())) report(node, `Missing translation: ${value}`); };
  walk(ast, (node, parent) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) imports.push(node.source.value);
    if (node.type === "CallExpression" && node.callee.type === "Import" && node.arguments[0]?.type === "StringLiteral") imports.push(node.arguments[0].value);
    if (translated(node)) {
      const argument = node.arguments[0];
      if (argument?.type === "StringLiteral") checkKey(node, argument.value);
      if (argument?.type === "TemplateLiteral" && argument.expressions.length) report(node, "Use a stable translation key and interpolation values.");
    }
    if (node.type === "CallExpression" && /^(?:notify|setError|set\w*Error|setMessage|setSuccess)$/.test(node.callee.name || "")) {
      const argument = node.arguments[0];
      if (argument?.type === "StringLiteral" && humanText(argument.value)) checkKey(node, argument.value);
      if (argument?.type === "TemplateLiteral" && argument.expressions.length) report(node, "Store feedback using a stable translation key and interpolation values.");
    }
    if (node.type === "ObjectProperty" && node.key.name === "key" && node.value.type === "StringLiteral" && /[\s{}]/.test(node.value.value)) checkKey(node, node.value.value);
    if (node.type === "JSXText" && humanText(node.value.trim())) report(node, `Untranslated JSX text: ${node.value.trim()}`);
    if (node.type === "JSXAttribute") {
      const name = node.name.name;
      if (presentationAttributes.has(name) && node.value?.type === "StringLiteral" && humanText(node.value.value)) report(node, `Untranslated ${name}: ${node.value.value}`);
      if (identityAttributes.has(name) && !(name === "value" && parent.name?.name === "Metric")) walk(node.value, child => { if (translated(child)) report(child, `Translation changes the technical ${name} attribute.`); });
    }
    if (node.type === "JSXExpressionContainer" && parent.type !== "JSXAttribute") {
      const expression = node.expression;
      const name = expression.type === "Identifier" ? expression.name : ["MemberExpression", "OptionalMemberExpression"].includes(expression.type) ? expression.property.name : "";
      if (/^(?:message|success|\w*[Ee]rror)$/.test(name)) report(node, `Translate displayed feedback: ${name}`);
    }
    if (node.type === "JSXElement" && node.openingElement.name.name === "option" && !node.openingElement.attributes.some(attribute => attribute.name?.name === "value")) {
      walk(node.children, child => { if (translated(child)) report(node, "Translated option needs an explicit, stable value."); });
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.name === "window" && ["confirm", "alert"].includes(node.callee.property.name)) {
      if (["StringLiteral", "TemplateLiteral"].includes(node.arguments[0]?.type)) report(node, "Translate the browser dialog before displaying it.");
    }
  });
  for (const source of imports) { const resolved = await resolveImport(file, source); if (resolved) await scan(resolved); }
}
await scan(path.join(root, "main.jsx"));
// Refund notices and previews are generated by the API. They do not appear as
// literal t() calls in the browser, so check the source of these system texts.
for (const name of ["policy.ts", "purchase-policy.ts"]) {
  const file = path.resolve(root, "../apps/api/src/refunds", name);
  const ast = parse(await readFile(file, "utf8"), { sourceType: "module", plugins: ["typescript"] });
  walk(ast, node => {
    if (node.type !== "ObjectProperty" || !["summary", "explanation"].includes(node.key.name)) return;
    walk(node.value, child => {
      if (child.type === "StringLiteral" && !Object.hasOwn(dictionary, child.value)) issues.add(`${name}:${child.loc.start.line}: Missing server policy translation: ${child.value}`);
    });
  });
}
if (issues.size) { console.error([...issues].join("\n")); process.exitCode = 1; }
else console.log(`Chinese catalog verified: ${Object.keys(dictionary).length} entries; ${visited.size} shipped modules checked for keys, placeholders and translation boundaries.`);
