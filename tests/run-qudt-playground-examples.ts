import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { InferenceEngine, loadDefaultRuleProfiles } from '../src';
import { parseRdfOrMessages, parseToQuads } from '../examples/util';

const QCR = 'https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#';
const QUDT = 'http://qudt.org/schema/qudt/';
const UNIT = 'http://qudt.org/vocab/unit/';
const CDT_UCUM = 'https://w3id.org/cdt/ucum';

interface ExpectedMessage {
  subject: string;
  unit?: string;
  value?: number;
  tolerance?: number;
}

interface ExampleExpectation {
  id: string;
  messages: ExpectedMessage[];
}

interface LoadedExample {
  expectation: ExampleExpectation;
  background: Quad[];
  input: ReturnType<typeof parseRdfOrMessages>;
  shaclIn: Quad[];
  shaclOut: Quad[];
}

const expectations: ExampleExpectation[] = [
  {
    id: 'qudt-mixed-speed',
    messages: [
      expected('qudt-speed', 'm1', 'M-PER-SEC', 12),
      expected('qudt-speed', 'm2', 'M-PER-SEC', 10),
      expected('qudt-speed', 'm3', 'M-PER-SEC', 4.4704),
      expected('qudt-speed', 'm4', 'M-PER-SEC', 5.144444444444445),
      invalid('qudt-speed', 'm5'),
    ],
  },
  {
    id: 'qudt-temperature-owl',
    messages: [
      expected('qudt-temperature', 'm1', 'K', 273.15),
      expected('qudt-temperature', 'm2', 'K', 273.15),
      expected('qudt-temperature', 'm3', 'K', 300),
    ],
  },
  {
    id: 'qudt-speed-skos',
    messages: [
      expected('qudt-speed-skos', 'm1', 'M-PER-SEC', 10),
      expected('qudt-speed-skos', 'm2', 'M-PER-SEC', 4.4704),
      expected('qudt-speed-skos', 'm3', 'M-PER-SEC', 5.144444444444445),
    ],
  },
  {
    id: 'qudt-logarithmic',
    messages: [
      expected('qudt-logarithmic', 'm1', 'UNITLESS', 100, 1e-10),
      expected('qudt-logarithmic', 'm2', 'UNITLESS', 10, 1e-10),
      expected('qudt-logarithmic', 'm3', 'UNITLESS', 8, 1e-10),
      expected('qudt-logarithmic', 'm4', 'UNITLESS', 1e-7, 1e-12),
    ],
  },
  {
    id: 'qudt-quantity-safety',
    messages: [
      expected('qudt-quantity-safety', 'm1', 'M', 1.5),
      expected('qudt-quantity-safety', 'm2', 'M', 2),
      invalid('qudt-quantity-safety', 'm3'),
      invalid('qudt-quantity-safety', 'm4'),
    ],
  },
];

let assertions = 0;
const selectedExample = process.env.QUDT_EXAMPLE;
const examples = expectations
  .filter((expectation) => !selectedExample || expectation.id === selectedExample)
  .map(loadExample);

if (!selectedExample) {
  const quantityObjectExamples = examples
    .filter((example) => example.input.quads.some((quad) => quad.predicate.value === QUDT + 'numericValue'))
    .map((example) => example.expectation.id);
  assert.deepEqual(quantityObjectExamples, ['qudt-quantity-safety'],
    'Only the quantity-safety playground fixture should use verbose QUDT quantity-object input.');
  assertions += 1;
}
const background = examples.flatMap((example) => example.background);
const shaclIn = examples.flatMap((example) => example.shaclIn);
const shaclOut = examples.flatMap((example) => example.shaclOut);

const preparedReasoner = new InferenceEngine();
const defaultProfiles = loadDefaultRuleProfiles();
const runtimeExpectations: Record<string, { maxKiB: number; units: number; forwardRules: string }> = {
  'qudt-mixed-speed': { maxKiB: 26, units: 4, forwardRules: '1' },
  'qudt-temperature-owl': { maxKiB: 27, units: 3, forwardRules: '1' },
  'qudt-speed-skos': { maxKiB: 36, units: 4, forwardRules: '1' },
  'qudt-logarithmic': { maxKiB: 40, units: 4, forwardRules: '5' },
  'qudt-quantity-safety': { maxKiB: 26, units: 3, forwardRules: '4' },
};

for (const example of examples) {
  const expectedRuntime = runtimeExpectations[example.expectation.id];
  const specializedReasoner = new InferenceEngine();
  specializedReasoner.load(defaultProfiles, example.background, {
    shaclIn: example.shaclIn,
    shaclOut: example.shaclOut,
  });
  const runtime = specializedReasoner.getRuntime();
  const projection = runtime.match(/Shape-specialized QUDT projection: (\d+) unit\(s\), (\d+)\/(\d+) facts\./);
  assert.ok(projection, `${example.expectation.id}: expected a shape-specialized QUDT fact projection.`);
  assert.equal(Number(projection[1]), expectedRuntime.units,
    `${example.expectation.id}: SHACL unit constraints should retain exactly ${expectedRuntime.units} units.`);
  assert.match(runtime, new RegExp(`Shape-specialized QUDT kernel: forward rule\\(s\\) ${expectedRuntime.forwardRules}\\.`),
    `${example.expectation.id}: unexpected QUDT forward-rule specialization.`);
  assert.ok(runtime.length < expectedRuntime.maxKiB * 1024,
    `${example.expectation.id}: specialized runtime should stay below ${expectedRuntime.maxKiB} KiB; got ${(runtime.length / 1024).toFixed(1)} KiB.`);
  assertions += 4;
}
const fullQudtRuntimeLength = defaultProfiles.find((profile) => profile.label === 'rules/qudt/qudt-cdt-normalization.n3')
  ?.precompiledRuntime?.length ?? 0;
preparedReasoner.load(defaultProfiles, background, { shaclIn, shaclOut });
const preparedRuntime = preparedReasoner.getRuntime();
assert.match(preparedRuntime, /Shape-specialized QUDT projection:/,
  'SHACL unit constraints should specialize the prepared QUDT projection.');
assert.ok(preparedRuntime.length < fullQudtRuntimeLength / 5,
  `Shape-specialized runtime should be substantially smaller than the ${fullQudtRuntimeLength}-character prepared profile; got ${preparedRuntime.length}.`);
assert.doesNotMatch(preparedRuntime, /<http:\/\/qudt\.org\/vocab\/unit\/A-HR> <http:\/\/qudt\.org\/schema\/qudt\/conversionMultiplier>/,
  'Shape specialization should omit unrelated QUDT unit facts.');
const requiredUnit = examples.flatMap((example) => example.expectation.messages)
  .find((message) => message.unit)?.unit;
assert.ok(requiredUnit && preparedRuntime.includes(`<${UNIT}${requiredUnit}> <${QUDT}conversionMultiplier>`),
  `Shape specialization should retain ${requiredUnit ?? 'a unit'} required by SHACL OUT.`);
assertions += 4;
if (examples.some((example) => example.expectation.id === 'qudt-temperature-owl')) {
  assert.match(preparedRuntime, /LocalFahrenheit/,
    'Prepared QUDT composition must retain the OWL-derived local-unit closure.');
  assertions += 1;
}
if (examples.some((example) => example.expectation.id === 'qudt-speed-skos')) {
  assert.match(preparedRuntime, /LocalKmh/,
    'Prepared QUDT composition must retain the SKOS-derived local-unit closure.');
  assertions += 1;
}

// Execute one complete example through the real prepared projection. The
// broader matrix below uses a compact fixture to keep the suite deterministic.
if (!selectedExample || selectedExample === examples[0]?.expectation.id) {
  runExample(examples[0], preparedReasoner);
}

const reasoner = new InferenceEngine();
reasoner.load(
  loadDefaultRuleProfiles().map((profile) => profile.label === 'rules/qudt/qudt-cdt-normalization.n3'
    ? { n3: profile.n3, label: profile.label }
    : profile),
  [...background, ...parseToQuads(minimalPlaygroundQudtBackground())],
  {
    shaclIn,
    shaclOut,
    selectRuntimeRules: false,
  },
);
for (const example of examples) {
  runExample(example, reasoner);
}

console.log(`QUDT playground examples: ${examples.length} examples and ${assertions} semantic assertions passed.`);

function loadExample(expectation: ExampleExpectation): LoadedExample {
  const directory = join('examples', expectation.id);
  return {
    expectation,
    background: parseToQuads(readFileSync(join(directory, 'ontology.n3'), 'utf8')),
    input: parseRdfOrMessages(readFileSync(join(directory, 'input.messages.trig'), 'utf8')),
    shaclIn: parseToQuads(readFileSync(join(directory, 'shapes-in.n3'), 'utf8')),
    shaclOut: parseToQuads(readFileSync(join(directory, 'shapes-out.n3'), 'utf8')),
  };
}

function runExample(example: LoadedExample, reasoner: InferenceEngine): void {
  const { expectation, input } = example;

  assert.equal(input.isMessages, true, `${expectation.id}: expected RDF Messages input.`);
  assert.equal(input.messages.length, expectation.messages.length, `${expectation.id}: message count.`);
  assertions += 2;

  const output = Array.from(reasoner.infer(input.quads));

  for (let index = 0; index < expectation.messages.length; index += 1) {
    assertExpectedMessage(expectation.id, output, expectation.messages[index]);
    if (expectation.id === 'qudt-logarithmic' && expectation.messages[index].unit) {
      assertNormalizedUcumLiteral(expectation.id, output, expectation.messages[index]);
    }
  }
}

function assertNormalizedUcumLiteral(example: string, output: Quad[], expectation: ExpectedMessage): void {
  const literals = output.filter((quad) => quad.subject.value === expectation.subject
    && quad.predicate.value === QCR + 'normalizedUcumLiteral');
  assert.equal(literals.length, 1, `${example}: ${expectation.subject} needs one normalized cdt:ucum literal.`);
  const literal = literals[0].object;
  assert.equal(literal.termType, 'Literal', `${example}: normalized UCUM output must be a literal.`);
  assert.equal(literal.termType === 'Literal' ? literal.datatype.value : undefined, CDT_UCUM,
    `${example}: normalized UCUM output must use the current cdt:ucum datatype.`);
  const [numericToken, unitToken, ...extra] = literal.value.trim().split(/\s+/);
  assert.equal(unitToken, '1', `${example}: normalized dimensionless UCUM output must use unit token 1.`);
  assert.equal(extra.length, 0, `${example}: normalized UCUM output must contain one numeric and one unit token.`);
  assert.ok(approximately(Number(numericToken), expectation.value ?? Number.NaN, expectation.tolerance ?? 1e-10),
    `${example}: expected UCUM numeric value ${expectation.value}, got ${numericToken}.`);
  assertions += 6;
}

function assertExpectedMessage(example: string, output: Quad[], expectation: ExpectedMessage): void {
  const links = output.filter((quad) => quad.subject.value === expectation.subject
    && quad.predicate.value === QCR + 'normalizedQuantity');

  if (!expectation.unit) {
    assert.equal(links.length, 0, `${example}: ${expectation.subject} must remain without misleading normalized output.`);
    assertions += 1;
    return;
  }

  const summaries = links.map((link) => {
    const value = object(output, link.object, QUDT + 'numericValue');
    const unit = object(output, link.object, QUDT + 'unit');
    const source = object(output, link.object, QCR + 'sourceQuantity');
    return `${link.object.value}[${value?.value ?? '?'},${unit?.value ?? '?'},${source?.value ?? '?'}]`;
  });
  assert.equal(links.length, 1, `${example}: ${expectation.subject} must satisfy SHACL OUT with one normalized quantity; got ${summaries.join(', ')}.`);
  const quantity = links[0].object;
  const value = object(output, quantity, QUDT + 'numericValue');
  const unit = object(output, quantity, QUDT + 'unit');
  assert.equal(unit?.value, UNIT + expectation.unit, `${example}: normalized unit required by SHACL OUT.`);
  assert.ok(value?.termType === 'Literal', `${example}: normalized quantity needs a numeric literal.`);
  assert.ok(approximately(Number(value.value), expectation.value ?? Number.NaN, expectation.tolerance ?? 1e-10),
    `${example}: expected ${expectation.value}, got ${value.value}.`);
  assertions += 4;
}

function object(quads: Quad[], subject: Term, predicate: string): Term | undefined {
  return quads.find((quad) => sameTerm(quad.subject, subject) && quad.predicate.value === predicate)?.object;
}

function sameTerm(left: Term, right: Term): boolean {
  return left.termType === right.termType && left.value === right.value;
}

function approximately(actual: number, expectedValue: number, tolerance: number): boolean {
  return Math.abs(actual - expectedValue) <= tolerance * Math.max(1, Math.abs(expectedValue));
}

function expected(namespace: string, localName: string, unit: string, value: number, tolerance = 1e-10): ExpectedMessage {
  return { subject: `https://example.org/${namespace}#${localName}`, unit, value, tolerance };
}

function invalid(namespace: string, localName: string): ExpectedMessage {
  return { subject: `https://example.org/${namespace}#${localName}` };
}

function minimalPlaygroundQudtBackground(): string {
  return `
@prefix ex: <https://example.org/qudt-playground-test#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
unit:M qudt:hasDimensionVector ex:Length ; qudt:conversionMultiplier 1.0 ; qudt:symbol "m" .
unit:CentiM qudt:hasDimensionVector ex:Length ; qudt:conversionMultiplier 0.01 ; qudt:symbol "cm" .
unit:SEC qudt:hasDimensionVector ex:Time ; qudt:conversionMultiplier 1.0 ; qudt:symbol "s" .
unit:M-PER-SEC qudt:hasDimensionVector ex:Speed ; qudt:conversionMultiplier 1.0 ; qudt:symbol "m/s" .
unit:KiloM-PER-HR qudt:hasDimensionVector ex:Speed ; qudt:conversionMultiplier 0.27777777777777777778 ; qudt:symbol "km/h" .
unit:MI-PER-HR qudt:hasDimensionVector ex:Speed ; qudt:conversionMultiplier 0.44704 ; qudt:symbol "mi/h" .
unit:KN qudt:hasDimensionVector ex:Speed ; qudt:conversionMultiplier 0.51444444444444444444 ; qudt:symbol "kn" .
unit:K qudt:hasDimensionVector ex:Temperature ; qudt:conversionMultiplier 1.0 ; qudt:symbol "K" .
unit:DEG_C qudt:hasDimensionVector ex:Temperature ; qudt:conversionMultiplier 1.0 ; qudt:conversionOffset 273.15 ; qudt:symbol "Cel" .
unit:DEG_F qudt:hasDimensionVector ex:Temperature ; qudt:conversionMultiplier 0.55555555555555555556 ; qudt:conversionOffset 459.67 ; qudt:symbol "[degF]" .
unit:UNITLESS qudt:hasDimensionVector ex:Dimensionless ; qudt:conversionMultiplier 1.0 ; qudt:symbol "1" .
unit:DeciB a qudt:LogarithmicUnit ; qudt:symbol "dB" .
unit:OCT a qudt:LogarithmicUnit ; qudt:symbol "octave" .
unit:PH a qudt:LogarithmicUnit ; qudt:symbol "pH" .
`;
}
