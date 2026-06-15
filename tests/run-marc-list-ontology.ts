import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const timeoutMs = 40_000;
const script = String.raw`
const { readFileSync } = require('node:fs');
const { InferenceEngine } = require('./dist/src');
const { parseRdf } = require('./dist/tests/utils');
const { parseRdfOrMessages } = require('./dist/examples/util');
const owlProfile = { n3: readFileSync('rules/owl2rl-eyeling.n3', 'utf8'), label: 'rules/owl2rl-eyeling.n3' };
const source = readFileSync('tests/fixtures/marc-list-ontology.n3', 'utf8');
const quads = parseRdf(source);
const input = parseRdfOrMessages(readFileSync('tests/fixtures/marc-list-messages.trig', 'utf8'));
const started = Date.now();
const reasoner = new InferenceEngine();
reasoner.load(owlProfile, quads);
const loadElapsed = Date.now() - started;
const runtime = reasoner.getRuntime();
if (!runtime.includes('<https://codeberg.org/phochste/marcattacks#RecordReadyForBasicExtraction>')) {
  throw new Error('Generated runtime does not contain the MARC ontology.');
}
if (!input.isMessages || input.messages.length !== 3) {
  throw new Error('Expected three RDF Messages in the MARC list data fixture.');
}
const perMessage = [];
for (const message of input.messages) {
  const messageStarted = Date.now();
  const output = Array.from(reasoner.infer(message));
  perMessage.push({ inputQuads: message.length, outputQuads: output.length, elapsed: Date.now() - messageStarted });
}
const allStarted = Date.now();
const allOutput = Array.from(reasoner.infer(input.quads));
const allElapsed = Date.now() - allStarted;
const typeObjects = allOutput
  .filter((quad) => quad.subject.termType === 'NamedNode'
    && quad.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
  .map((quad) => [quad.subject.value, quad.object.value].join(' '));
const readyRecords = typeObjects.filter((value) => value.endsWith(' https://codeberg.org/phochste/marcattacks#RecordReadyForBasicExtraction'));
const subjectRecords = typeObjects.filter((value) => value.endsWith(' https://codeberg.org/phochste/marcattacks#RecordWithExtractableSubject'));
if (readyRecords.length !== 3) {
  throw new Error('Expected all three records to be ready for basic extraction.');
}
if (subjectRecords.length !== 1) {
  throw new Error('Expected only the third record to have an extractable subject.');
}
console.log(JSON.stringify({
  ontologyQuads: quads.length,
  messageQuads: input.quads.length,
  messages: input.messages.length,
  loadElapsed,
  perMessage,
  allElapsed,
  allOutputQuads: allOutput.length,
  runtimeBytes: runtime.length,
}));
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

const report = JSON.parse(result.stdout.trim()) as {
  ontologyQuads: number;
  messageQuads: number;
  messages: number;
  loadElapsed: number;
  perMessage: Array<{ inputQuads: number; outputQuads: number; elapsed: number }>;
  allElapsed: number;
  allOutputQuads: number;
  runtimeBytes: number;
};
assert.equal(report.ontologyQuads, 297, 'Unexpected MARC ontology fixture size.');
assert.equal(report.messages, 3, 'Unexpected MARC message count.');
assert.equal(report.messageQuads, 446, 'Unexpected MARC message fixture size.');
assert.ok(report.loadElapsed < timeoutMs, `MARC list ontology load took ${report.loadElapsed} ms.`);
assert.ok(report.perMessage.every((message) => message.elapsed < timeoutMs), `At least one MARC message exceeded ${timeoutMs} ms: ${JSON.stringify(report.perMessage)}.`);
assert.ok(report.allElapsed < timeoutMs, `Combined MARC message inference took ${report.allElapsed} ms.`);
assert.equal(report.allOutputQuads, 16, 'Unexpected combined MARC inference output size.');
assert.ok(report.runtimeBytes > 0, 'Expected a non-empty generated runtime.');

console.log(`MARC list ontology/data test: ${report.ontologyQuads} ontology quads loaded in ${report.loadElapsed} ms; ${report.messageQuads} message quads inferred in ${report.allElapsed} ms.`);
