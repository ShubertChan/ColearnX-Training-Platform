import assert from 'node:assert/strict';
import test from 'node:test';
import { highSeverityFindings, compareFindings } from './codeql-gate.mjs';

test('CodeQL gates extension rules even when the SARIF result itself is a warning', () => {
  const report = { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' },
    extensions: [{ rules: ['6.9', '7.0', '9.8'].map(s => ({ id: 'q' + s, properties: { 'security-severity': s } })) }] },
    results: ['6.9', '7.0', '9.8'].map(s => ({ ruleId: 'q' + s, level: 'warning',
      partialFingerprints: { primaryLocationLineHash: 'abc:1' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'api.ts' } } }] })) }] };
  const high = highSeverityFindings(report);
  assert.deepEqual(high.map(f => f.id), ['q7.0', 'q9.8']);
  assert.deepEqual(compareFindings(high, high), [high[1]], 'critical blocks even on base');
  assert.deepEqual(compareFindings([high[0], high[0]], [high[0]]), [high[0]]);
  const elsewhere = { ...high[0], path: 'other.ts' };
  assert.deepEqual(compareFindings([elsewhere], [high[0]]), [elsewhere]);
  report.runs[0].results = [];
  assert.deepEqual(highSeverityFindings(report), []);
  report.runs[0].results = [{ ruleId: 'unknown' }];
  assert.throws(() => highSeverityFindings(report), /Missing severity/);
  assert.throws(() => highSeverityFindings({ version: '2.1.0', runs: [] }), /Missing SARIF/);
});
