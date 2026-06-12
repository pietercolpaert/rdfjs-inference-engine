import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const timeoutMs = 25_000;
const script = String.raw`
const { readFileSync } = require('node:fs');
const { InferenceEngine } = require('./dist/src');
const { parseRdf } = require('./dist/tests/utils');
const source = readFileSync('tests/fixtures/marc-list-ontology.n3', 'utf8');
const quads = parseRdf(source);
const started = Date.now();
const reasoner = new InferenceEngine();
reasoner.load(quads);
const elapsed = Date.now() - started;
const runtime = reasoner.getRuntime();
if (!runtime.includes('<https://codeberg.org/phochste/marcattacks#RecordReadyForBasicExtraction>')) {
  throw new Error('Generated runtime does not contain the MARC ontology.');
}
console.log(JSON.stringify({ quads: quads.length, elapsed, runtimeBytes: runtime.length }));
`;

const result = spawnSync(process.execPath, ['-e', script], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: timeoutMs,
  maxBuffer: 1024 * 1024,
});

assert.equal(
  result.error,
  undefined,
  `MARC list ontology load did not complete within ${timeoutMs} ms. ${result.error?.message ?? ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);
assert.equal(
  result.status,
  0,
  `MARC list ontology load failed. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);

const report = JSON.parse(result.stdout.trim()) as { quads: number; elapsed: number; runtimeBytes: number };
assert.equal(report.quads, 297, 'Unexpected MARC fixture size.');
assert.ok(report.elapsed < timeoutMs, `MARC list ontology load took ${report.elapsed} ms.`);
assert.ok(report.runtimeBytes > 0, 'Expected a non-empty generated runtime.');

console.log(`MARC list ontology load test: ${report.quads} quads loaded in ${report.elapsed} ms.`);
