import assert from 'node:assert/strict';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A successful analyzer invocation alone does not mean it found no vulnerabilities.
export function highSeverityFindings(sarif) {
  assert.ok(sarif.version === '2.1.0' && sarif.runs?.length, 'Missing SARIF runs');
  const blocking = [];
  for (const run of sarif.runs) {
    assert.ok(run.tool?.driver?.name === 'CodeQL' && Array.isArray(run.results), 'Incomplete CodeQL analysis');
    assert.ok(!(run.invocations ?? []).some(inv => inv.executionSuccessful === false), 'CodeQL invocation failed');
    const rules = new Map();
    for (const tool of [run.tool.driver, ...(run.tool.extensions ?? [])]) {
      for (const rule of tool.rules ?? []) {
        const severity = rule.properties?.['security-severity'];
        const security = rule.properties?.tags?.includes('security');
        assert.ok((severity === undefined && !security) || (severity != null && String(severity).trim() &&
          Number.isFinite(Number(severity)) && Number(severity) >= 0 && Number(severity) <= 10),
        'Invalid or missing security-severity: ' + rule.id);
        rules.set(rule.id, Math.max(rules.get(rule.id) ?? 0, Number(severity ?? 0)));
      }
    }
    assert.ok(rules.size, 'Missing CodeQL rule metadata');
    for (const finding of run.results) {
      const id = finding.ruleId ?? finding.rule?.id;
      assert.ok(rules.has(id), 'Missing severity metadata for result ' + id);
      if (rules.get(id) < 7) continue;
      const location = finding.locations?.[0]?.physicalLocation;
      const path = location?.artifactLocation?.uri;
      const hash = finding.partialFingerprints?.primaryLocationLineHash;
      assert.ok(path && hash, 'Cannot compare a high-severity finding without a source path and fingerprint: ' + id);
      blocking.push({ id, path, hash, line: location.region?.startLine, severity: rules.get(id) });
    }
  }
  return blocking;
}

// Multiset matching: fixing one result cannot hide a new one elsewhere, or a
// second occurrence with the same fingerprint. A critical always blocks.
export function compareFindings(head, base) {
  const counts = new Map(), added = [];
  const key = r => JSON.stringify([r.id, r.path, r.hash]);
  for (const r of base) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  for (const r of head) {
    const k = key(r), left = counts.get(k) ?? 0;
    if (left) counts.set(k, left - 1);
    if (!left || r.severity >= 9) added.push(r);
  }
  return added;
}

async function readFindings(dir) {
  const files = (await readdir(dir)).filter(name => name.endsWith('.sarif'));
  assert.ok(files.length, 'No CodeQL report produced');
  const runs = await Promise.all(files.map(async file => highSeverityFindings(JSON.parse(await readFile(resolve(dir, file), 'utf8')))));
  return runs.flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const head = await readFindings(process.argv[2]);
  const base = process.argv[3] ? await readFindings(process.argv[3]) : [];
  const blocked = compareFindings(head, base);
  const summary = 'CodeQL high/critical findings: head ' + head.length + ', base ' + base.length +
    ', blocking (new high or any critical) ' + blocked.length + '. See both full SARIF reports.';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  for (const r of blocked) console.error(r.id + ' at ' + r.path + ':' + r.line);
  if (blocked.length) process.exitCode = 1;
}
