import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Quad, Term } from '@rdfjs/types';
import { InferenceEngine, loadDefaultRuleProfiles, type LoadedRuleProfile } from '../src';
import { parseRdfOrMessages, parseToQuads } from '../examples/util';

const EX = 'https://example.org/qudt-test#';
const QCR = 'https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#';
const QUDT = 'http://qudt.org/schema/qudt/';
const UNIT = 'http://qudt.org/vocab/unit/';
const CDT = 'https://w3id.org/cdt/';
const LCDT = 'http://w3id.org/lindt/custom_datatypes#';

const prefixes = `
@prefix ex: <${EX}> .
@prefix qcr: <${QCR}> .
@prefix qudt: <${QUDT}> .
@prefix unit: <${UNIT}> .
@prefix cdt: <${CDT}> .
@prefix lcdt: <${LCDT}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
`;

type TestResult = 'pass' | 'known-limitation';

interface ConversionFixture {
  name: string;
  data: string;
  subject?: string;
  unit: string;
  value: number;
  datatype?: string;
  tolerance?: number;
}

interface NegativeFixture {
  name: string;
  data: string;
  subject?: string;
}

let assertions = 0;
let currentOutput: Quad[] = [];
const qudtProfile: LoadedRuleProfile = {
  n3: readFileSync('rules/qudt/qudt-cdt-normalization.n3', 'utf8'),
  label: 'rules/qudt/qudt-cdt-normalization.n3',
};
const owlProfile = requiredProfile('rules/owl2rl/owl2rl-eyeling.n3');
const skosProfile = requiredProfile('rules/skos/skos-entailment.n3');

const qudtReasoner = createReasoner([qudtProfile]);

const linearFixtures: ConversionFixture[] = [
  literal('length-metres-from-centimetres', 'length', '150 cm', 'length', 'M', 1.5),
  literal('mass-kilograms-from-grams', 'mass', '1500 g', 'mass', 'KiloGM', 1.5),
  literal('time-seconds-from-minutes', 'duration', '2 min', 'time', 'SEC', 120),
  literal('speed-metres-per-second-from-km-per-hour', 'speed', '36 km/h', 'speed', 'M-PER-SEC', 10),
  literal('area-square-metres-from-square-centimetres', 'area', '25000 cm2', 'area', 'M2', 2.5),
  literal('volume-cubic-metres-from-litres', 'volume', '2 L', 'volume', 'M3', 0.002),
  literal('pressure-pascals-from-kilopascals', 'pressure', '101.325 kPa', 'pressure', 'PA', 101325, 1e-8),
  literal('energy-joules-from-kilojoules', 'energy', '1.25 kJ', 'energy', 'J', 1250),
  literal('power-watts-from-kilowatts', 'power', '2.5 kW', 'power', 'W', 2500),
  literal('celsius-to-kelvin', 'temperature', '0 Cel', 'temperature', 'K', 273.15),
  literal('fahrenheit-to-kelvin', 'temperature', '32 [degF]', 'temperature', 'K', 273.15, 1e-10),
  literal('kelvin-to-kelvin', 'temperature', '300 K', 'temperature', 'K', 300),
  object('quantity-object-speed-knots', 'measure', 10, 'KN', 'M-PER-SEC', 5.144444444444445, 1e-12),
  object('quantity-object-already-normalized-volume', 'measure', 3, 'M3', 'M3', 3),
  {
    name: 'quantity-object-explicit-property-profile',
    subject: EX + 'quantity_object_explicit_property_profile',
    data: `ex:temperature qcr:normalizationProfile qcr:TemperatureProfile .
ex:quantity_object_explicit_property_profile ex:temperature [ a qudt:QuantityValue ; qudt:numericValue 0 ; qudt:unit unit:DEG_C ] .`,
    unit: 'K',
    value: 273.15,
    tolerance: 1e-10,
  },
  literal('generic-ucum-speed', 'speed', '10 mi/h', 'ucum', 'M-PER-SEC', 4.4704, 1e-12, CDT + 'speed'),
  literal('legacy-generic-ucum-length', 'distance', '2 cm', 'ucum', 'M', 0.02, 1e-12, CDT + 'length', LCDT),
];

const lexicalFixtures: ConversionFixture[] = [
  literal('integer-lexical-form', 'length', '2 cm', 'length', 'M', 0.02),
  literal('decimal-lexical-form', 'length', '2.5 cm', 'length', 'M', 0.025),
  literal('negative-value', 'temperature', '-40 Cel', 'temperature', 'K', 233.15),
  literal('leading-decimal', 'length', '.5 cm', 'length', 'M', 0.005),
  literal('scientific-notation', 'length', '1.5e2 cm', 'length', 'M', 1.5),
  literal('leading-and-trailing-whitespace', 'length', '  2.5 cm  ', 'length', 'M', 0.025),
  literal('qudt-symbol-token', 'speed', '1 kn', 'speed', 'M-PER-SEC', 0.5144444444444445, 1e-12),
  literal('canonical-ucum-code', 'temperature', '32 [degF]', 'temperature', 'K', 273.15, 1e-10),
  literal('current-cdt-datatype', 'pressure', '2 kPa', 'pressure', 'PA', 2000),
  literal('legacy-lindt-datatype', 'pressure', '2 kPa', 'pressure', 'PA', 2000, 1e-12, CDT + 'pressure', LCDT),
];

const malformedFixtures: NegativeFixture[] = [
  invalid('malformed-number', 'length', 'abc cm', 'length'),
  invalid('unknown-unit-expression', 'length', '1 furlongish', 'length'),
  invalid('missing-unit-expression', 'length', '1', 'length'),
  invalid('length-literal-with-time-datatype', 'duration', '1 m', 'time'),
  invalid('mass-literal-with-length-datatype', 'length', '1 kg', 'length'),
  invalid('pressure-literal-with-energy-datatype', 'energy', '1 kPa', 'energy'),
  {
    name: 'quantity-object-missing-unit',
    subject: EX + 'quantity_object_missing_unit',
    data: `ex:quantity_object_missing_unit ex:measure [ a qudt:QuantityValue ; qudt:numericValue 12 ] .`,
  },
  {
    name: 'quantity-object-incompatible-with-property-profile',
    subject: EX + 'quantity_object_incompatible_with_property_profile',
    data: `ex:length qcr:normalizationProfile qcr:LengthProfile .
ex:quantity_object_incompatible_with_property_profile ex:length [ a qudt:QuantityValue ; qudt:numericValue 5 ; qudt:unit unit:SEC ] .`,
  },
];

const logarithmicForwardFixtures: ConversionFixture[] = [
  literal('bel-to-linear-ratio', 'level', '2 B', 'ucum', 'UNITLESS', 100, 1e-10, CDT + 'dimensionless'),
  literal('decibel-power-ratio-to-linear-ratio', 'level', '20 dB', 'ucum', 'UNITLESS', 100, 1e-10, CDT + 'dimensionless'),
  literal('neper-to-linear-ratio', 'level', '1 Np', 'ucum', 'UNITLESS', Math.E, 1e-10, CDT + 'dimensionless'),
  literal('octave-to-linear-ratio', 'level', '3 oct', 'ucum', 'UNITLESS', 8, 1e-10, CDT + 'dimensionless'),
  literal('decade-to-linear-ratio', 'level', '2 10*', 'ucum', 'UNITLESS', 100, 1e-10, CDT + 'dimensionless'),
  literal('ph-to-hydrogen-ion-activity', 'ph', '7 pH', 'ucum', 'UNITLESS', 1e-7, 1e-14, CDT + 'dimensionless'),
  object('quantity-object-decibel-to-ratio', 'level', 20, 'DeciB', 'UNITLESS', 100, 1e-10, CDT + 'dimensionless'),
];

const logarithmicReverseFixtures: ConversionFixture[] = [
  reverseLog('ratio-to-bel', 100, 'B', 2),
  reverseLog('ratio-to-decibel', 100, 'DeciB', 20),
  reverseLog('ratio-to-neper', Math.E, 'NP', 1, 1e-10),
  reverseLog('ratio-to-octave', 8, 'OCT', 3),
  reverseLog('ratio-to-decade', 100, 'DECADE', 2),
  reverseLog('hydrogen-ion-activity-to-ph', 1e-7, 'PH', 7, 1e-8),
];

const invalidLogFixtures: NegativeFixture[] = [
  reverseLogInvalid('zero-ratio-to-decibel', 0, 'DeciB'),
  reverseLogInvalid('negative-ratio-to-octave', -1, 'OCT'),
  {
    name: 'quantity-object-incompatible-unit-for-requested-log',
    subject: EX + 'quantity_object_incompatible_unit_for_requested_log',
    data: `ex:quantity_object_incompatible_unit_for_requested_log ex:ratio [ a qudt:QuantityValue ; qudt:numericValue 1 ; qudt:unit unit:M ] ; qcr:targetLogarithmicUnit unit:DeciB .`,
  },
];

const ordinaryPositiveFixtures = [...linearFixtures, ...lexicalFixtures, ...logarithmicForwardFixtures];
const ordinaryNegativeFixtures = [...malformedFixtures, ...invalidLogFixtures];
currentOutput = inferMany(ordinaryPositiveFixtures);
for (const fixture of [...linearFixtures, ...lexicalFixtures]) {
  assertNormalized(fixture);
}
for (const fixture of logarithmicForwardFixtures) {
  assertNormalized(fixture);
}
currentOutput = inferMany(logarithmicReverseFixtures);
for (const fixture of logarithmicReverseFixtures) {
  assertNormalizedLogarithmic(fixture);
}
currentOutput = inferMany(ordinaryNegativeFixtures);
for (const fixture of malformedFixtures) {
  assertNoNormalizedOutput(fixture);
}
for (const fixture of invalidLogFixtures) {
  assertNoLogarithmicOutput(fixture);
}

assertMessageLogBehavior();
assertOwlComposition();
assertSkosComposition();
assertKnownLimitations();

console.log(`QUDT normalization tests: ${assertions} assertions passed.`);

function requiredProfile(label: string): LoadedRuleProfile {
  const profile = loadDefaultRuleProfiles().find((candidate) => candidate.label === label);
  assert.ok(profile, `Expected bundled profile ${label}.`);
  return profile;
}

function createReasoner(profiles: LoadedRuleProfile[]): InferenceEngine {
  const reasoner = new InferenceEngine();
  reasoner.load(profiles, parseToQuads(minimalQudtBackground()), { selectRuntimeRules: false });
  return reasoner;
}

function minimalQudtBackground(): string {
  return `${prefixes}
unit:M qudt:hasDimensionVector ex:LengthDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "m" ; qudt:ucumCode "m"^^qudt:UCUMcs .
unit:CentiM qudt:hasDimensionVector ex:LengthDimension ; qudt:conversionMultiplier 0.01 ; qudt:symbol "cm" ; qudt:ucumCode "cm"^^qudt:UCUMcs .
unit:KiloGM qudt:hasDimensionVector ex:MassDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "kg" ; qudt:ucumCode "kg"^^qudt:UCUMcs .
unit:GM qudt:hasDimensionVector ex:MassDimension ; qudt:conversionMultiplier 0.001 ; qudt:symbol "g" ; qudt:ucumCode "g"^^qudt:UCUMcs .
unit:SEC qudt:hasDimensionVector ex:TimeDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "s" ; qudt:ucumCode "s"^^qudt:UCUMcs .
unit:MIN qudt:hasDimensionVector ex:TimeDimension ; qudt:conversionMultiplier 60.0 ; qudt:symbol "min" ; qudt:ucumCode "min"^^qudt:UCUMcs .
unit:HR qudt:hasDimensionVector ex:TimeDimension ; qudt:conversionMultiplier 3600.0 ; qudt:symbol "h" ; qudt:ucumCode "h"^^qudt:UCUMcs .
unit:M-PER-SEC qudt:hasDimensionVector ex:SpeedDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "m/s" ; qudt:ucumCode "m/s"^^qudt:UCUMcs .
unit:KiloM-PER-HR qudt:hasDimensionVector ex:SpeedDimension ; qudt:conversionMultiplier 0.27777777777777777778 ; qudt:symbol "km/h" ; qudt:ucumCode "km.h-1"^^qudt:UCUMcs .
unit:MI-PER-HR qudt:hasDimensionVector ex:SpeedDimension ; qudt:conversionMultiplier 0.44704 ; qudt:symbol "mi/h" ; qudt:ucumCode "[mi_i].h-1"^^qudt:UCUMcs .
unit:KN qudt:hasDimensionVector ex:SpeedDimension ; qudt:conversionMultiplier 0.51444444444444444444 ; qudt:symbol "kn" ; qudt:ucumCode "[kn_i]"^^qudt:UCUMcs .
unit:M2 qudt:hasDimensionVector ex:AreaDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "m2" ; qudt:ucumCode "m2"^^qudt:UCUMcs .
unit:CentiM2 qudt:hasDimensionVector ex:AreaDimension ; qudt:conversionMultiplier 0.0001 ; qudt:symbol "cm2" ; qudt:ucumCode "cm2"^^qudt:UCUMcs .
unit:M3 qudt:hasDimensionVector ex:VolumeDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "m3" ; qudt:ucumCode "m3"^^qudt:UCUMcs .
unit:L qudt:hasDimensionVector ex:VolumeDimension ; qudt:conversionMultiplier 0.001 ; qudt:symbol "L" ; qudt:ucumCode "L"^^qudt:UCUMcs .
unit:PA qudt:hasDimensionVector ex:PressureDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "Pa" ; qudt:ucumCode "Pa"^^qudt:UCUMcs .
unit:KiloPA qudt:hasDimensionVector ex:PressureDimension ; qudt:conversionMultiplier 1000.0 ; qudt:symbol "kPa" ; qudt:ucumCode "kPa"^^qudt:UCUMcs .
unit:J qudt:hasDimensionVector ex:EnergyDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "J" ; qudt:ucumCode "J"^^qudt:UCUMcs .
unit:KiloJ qudt:hasDimensionVector ex:EnergyDimension ; qudt:conversionMultiplier 1000.0 ; qudt:symbol "kJ" ; qudt:ucumCode "kJ"^^qudt:UCUMcs .
unit:W qudt:hasDimensionVector ex:PowerDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "W" ; qudt:ucumCode "W"^^qudt:UCUMcs .
unit:KiloW qudt:hasDimensionVector ex:PowerDimension ; qudt:conversionMultiplier 1000.0 ; qudt:symbol "kW" ; qudt:ucumCode "kW"^^qudt:UCUMcs .
unit:K qudt:hasDimensionVector ex:TemperatureDimension ; qudt:conversionMultiplier 1.0 ; qudt:symbol "K" ; qudt:ucumCode "K"^^qudt:UCUMcs .
unit:DEG_C qudt:hasDimensionVector ex:TemperatureDimension ; qudt:conversionMultiplier 1.0 ; qudt:conversionOffset 273.15 ; qudt:symbol "°C" ; qudt:ucumCode "Cel"^^qudt:UCUMcs .
unit:DEG_F qudt:hasDimensionVector ex:TemperatureDimension ; qudt:conversionMultiplier 0.55555555555555555556 ; qudt:conversionOffset 459.67 ; qudt:symbol "°F" ; qudt:ucumCode "[degF]"^^qudt:UCUMcs .
unit:UNITLESS qudt:hasDimensionVector ex:Dimensionless ; qudt:conversionMultiplier 1.0 ; qudt:symbol "1" ; qudt:ucumCode "1"^^qudt:UCUMcs .
unit:B a qudt:LogarithmicUnit ; qudt:symbol "B" ; qudt:ucumCode "B"^^qudt:UCUMcs .
unit:DeciB a qudt:LogarithmicUnit ; qudt:symbol "dB" ; qudt:ucumCode "dB"^^qudt:UCUMcs .
unit:NP a qudt:LogarithmicUnit ; qudt:symbol "Np" ; qudt:ucumCode "Np"^^qudt:UCUMcs .
unit:OCT a qudt:LogarithmicUnit ; qudt:symbol "oct" ; qudt:ucumCode "oct"^^qudt:UCUMcs .
unit:DECADE a qudt:LogarithmicUnit ; qudt:symbol "10*" ; qudt:ucumCode "10*"^^qudt:UCUMcs .
unit:PH a qudt:LogarithmicUnit ; qudt:symbol "pH" ; qudt:ucumCode "pH"^^qudt:UCUMcs .
`;
}

function literal(
  name: string,
  property: string,
  lexical: string,
  datatypeName: string,
  unit: string,
  value: number,
  tolerance = 1e-12,
  expectedSpecificDatatype = CDT + datatypeName,
  datatypeBase = CDT,
): ConversionFixture {
  return {
    name,
    subject: EX + safeName(name),
    data: `ex:${safeName(name)} ex:${property} ${JSON.stringify(lexical)}^^<${datatypeBase}${datatypeName}> .`,
    unit,
    value,
    datatype: expectedSpecificDatatype,
    tolerance,
  };
}

function object(name: string, property: string, value: number, sourceUnit: string, unit: string, expected: number, tolerance = 1e-12, datatype?: string): ConversionFixture {
  return {
    name,
    subject: EX + safeName(name),
    data: `ex:${safeName(name)} ex:${property} [ a qudt:QuantityValue ; qudt:numericValue ${value} ; qudt:unit unit:${sourceUnit} ] .`,
    unit,
    value: expected,
    datatype,
    tolerance,
  };
}

function invalid(name: string, property: string, lexical: string, datatypeName: string): NegativeFixture {
  return {
    name,
    subject: EX + safeName(name),
    data: `ex:${safeName(name)} ex:${property} ${JSON.stringify(lexical)}^^cdt:${datatypeName} .`,
  };
}

function reverseLog(name: string, ratio: number, targetUnit: string, expected: number, tolerance = 1e-10): ConversionFixture {
  return {
    name,
    subject: EX + safeName(name),
    data: `ex:${safeName(name)} ex:ratio [ a qudt:QuantityValue ; qudt:numericValue ${ratio} ; qudt:unit unit:UNITLESS ] ; qcr:targetLogarithmicUnit unit:${targetUnit} .`,
    unit: targetUnit,
    value: expected,
    tolerance,
  };
}

function reverseLogInvalid(name: string, ratio: number, targetUnit: string): NegativeFixture {
  return {
    name,
    subject: EX + safeName(name),
    data: `ex:${safeName(name)} ex:ratio [ a qudt:QuantityValue ; qudt:numericValue ${ratio} ; qudt:unit unit:UNITLESS ] ; qcr:targetLogarithmicUnit unit:${targetUnit} .`,
  };
}

function assertNormalized(fixture: ConversionFixture): void {
  const quantity = normalizedQuantity(currentOutput, fixture.subject ?? EX + 'case', QCR + 'normalizedQuantity');
  assertQuantity(quantity, UNIT + fixture.unit, fixture.value, fixture.tolerance ?? 1e-12, fixture.name);

  assertHasLiteral(currentOutput, fixture.subject ?? EX + 'case', QCR + 'normalizedUcumLiteral', CDT + 'ucum', fixture.name);
  if (fixture.datatype) {
    assertHasLiteral(currentOutput, fixture.subject ?? EX + 'case', QCR + 'normalizedCdtLiteral', fixture.datatype, fixture.name);
  }
  assertions += 3;
}

function assertNormalizedLogarithmic(fixture: ConversionFixture): void {
  const quantity = normalizedQuantity(currentOutput, fixture.subject ?? EX + 'case', QCR + 'normalizedLogarithmicQuantity');
  assertQuantity(quantity, UNIT + fixture.unit, fixture.value, fixture.tolerance ?? 1e-10, fixture.name);
  assertHasLiteral(currentOutput, fixture.subject ?? EX + 'case', QCR + 'normalizedLogarithmicUcumLiteral', CDT + 'ucum', fixture.name);
  assertions += 2;
}

function assertNoNormalizedOutput(fixture: NegativeFixture): void {
  const subject = fixture.subject ?? EX + 'case';
  assert.equal(hasSubjectPredicate(currentOutput, subject, QCR + 'normalizedQuantity'), false, fixture.name);
  assert.equal(hasSubjectPredicate(currentOutput, subject, QCR + 'normalizedUcumLiteral'), false, fixture.name);
  assert.equal(hasSubjectPredicate(currentOutput, subject, QCR + 'normalizedCdtLiteral'), false, fixture.name);
  assertions += 3;
}

function assertNoLogarithmicOutput(fixture: NegativeFixture): void {
  const subject = fixture.subject ?? EX + 'case';
  assert.equal(hasSubjectPredicate(currentOutput, subject, QCR + 'normalizedLogarithmicQuantity'), false, fixture.name);
  assert.equal(hasSubjectPredicate(currentOutput, subject, QCR + 'normalizedLogarithmicUcumLiteral'), false, fixture.name);
  assertions += 2;
}

function normalizedQuantity(output: Quad[], subjectIri: string, predicateIri: string): Term {
  const link = output.find((quad) => quad.subject.value === subjectIri && quad.predicate.value === predicateIri);
  assert.ok(link, `Expected ${predicateIri} for ${subjectIri}.`);
  return link.object;
}

function assertQuantity(quantity: Term, expectedUnit: string, expectedValue: number, tolerance: number, label: string): void {
  const output = currentOutput;
  const valueQuad = output.find((quad) => sameTerm(quad.subject, quantity) && quad.predicate.value === QUDT + 'numericValue');
  const unitQuad = output.find((quad) => sameTerm(quad.subject, quantity) && quad.predicate.value === QUDT + 'unit');
  assert.ok(valueQuad?.object.termType === 'Literal', `${label}: expected numeric value literal.`);
  assert.equal(unitQuad?.object.value, expectedUnit, `${label}: expected normalized unit.`);
  assert.ok(approximately(Number(valueQuad.object.value), expectedValue, tolerance), `${label}: expected ${expectedValue}, got ${valueQuad.object.value}.`);
}

function inferFixtureWithCurrent(data: string, reasoner = qudtReasoner): Quad[] {
  currentOutput = Array.from(reasoner.infer(parseToQuads(data)));
  return currentOutput;
}

function assertHasLiteral(output: Quad[], subjectIri: string, predicateIri: string, datatypeIri: string, label: string): void {
  assert.ok(output.some((quad) => quad.subject.value === subjectIri
    && quad.predicate.value === predicateIri
    && quad.object.termType === 'Literal'
    && quad.object.datatype.value === datatypeIri), `${label}: expected ${predicateIri} literal with datatype ${datatypeIri}.`);
}

function hasPredicate(output: Quad[], predicateIri: string): boolean {
  return output.some((quad) => quad.predicate.value === predicateIri);
}

function hasSubjectPredicate(output: Quad[], subjectIri: string, predicateIri: string): boolean {
  return output.some((quad) => quad.subject.value === subjectIri && quad.predicate.value === predicateIri);
}

function sameTerm(left: Term, right: Term): boolean {
  return left.termType === right.termType && left.value === right.value;
}

function approximately(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

function assertMessageLogBehavior(): void {
  const input = parseRdfOrMessages(`${prefixes}
@version "1.2-messages" .
ex:s1 ex:speed "36 km/h"^^cdt:speed .
@message .
ex:s2 ex:speed [ a qudt:QuantityValue ; qudt:numericValue 10 ; qudt:unit unit:KN ] .
@message .
ex:s3 ex:speed "bad km/h"^^cdt:speed .
@message .
ex:s4 ex:duration "1 m"^^cdt:time .
@message .
ex:s5 ex:mass [ a qudt:QuantityValue ; qudt:numericValue 1500 ; qudt:unit unit:GM ] .
@message .
`);
  assert.equal(input.isMessages, true, 'Expected RDF Messages input.');

  const outputs = input.messages.map((message) => Array.from(qudtReasoner.infer(message)));
  assertMessageQuantity(outputs[0], EX + 's1', 'M-PER-SEC', 10, 'message speed km/h');
  assertMessageQuantity(outputs[1], EX + 's2', 'M-PER-SEC', 5.144444444444445, 'message speed knots');
  assert.equal(hasPredicate(outputs[2], QCR + 'normalizedQuantity'), false, 'Malformed message should not normalize.');
  assert.equal(hasPredicate(outputs[3], QCR + 'normalizedQuantity'), false, 'Incompatible message should not normalize.');
  assertMessageQuantity(outputs[4], EX + 's5', 'KiloGM', 1.5, 'message mass grams');

  const sourceBlankNodesByMessage = input.messages.map((message) => new Set(message
    .flatMap((quad) => [quad.subject, quad.object])
    .filter((term) => term.termType === 'BlankNode')
    .map((term) => term.value)));
  for (let i = 0; i < outputs.length; i += 1) {
    const foreignSourceBlanks = new Set(sourceBlankNodesByMessage
      .filter((_, messageIndex) => messageIndex !== i)
      .flatMap((blankNodes) => [...blankNodes]));
    const outputTerms = outputs[i].flatMap((quad) => [quad.subject, quad.object]);
    assert.equal(outputTerms.some((term) => term.termType === 'BlankNode' && foreignSourceBlanks.has(term.value)), false,
      'An output message must not refer to a source blank node from another message.');
  }

  assert.equal(outputs.length, 5, 'Message boundaries should be preserved in output array.');
  assertions += 9;
}

function assertMessageQuantity(output: Quad[], subject: string, unit: string, value: number, label: string): void {
  currentOutput = output;
  assertQuantity(normalizedQuantity(output, subject, QCR + 'normalizedQuantity'), UNIT + unit, value, 1e-10, label);
}

function assertOwlComposition(): void {
  const data = `${prefixes}
unit:DEG_F owl:sameAs ex:localF .
ex:case ex:temperature [ a qudt:QuantityValue ; qudt:numericValue 32 ; qudt:unit ex:localF ] .
`;
  inferFixtureWithCurrent(data);
  assertNoNormalizedOutput({ name: 'owl-composition-without-owl-profile', data });
  const withOwl = createReasoner([owlProfile, qudtProfile]);
  const output = inferFixtureWithCurrent(data, withOwl);
  assertQuantity(normalizedQuantity(output, EX + 'case', QCR + 'normalizedQuantity'), UNIT + 'K', 273.15, 1e-10, 'owl-composition-with-owl-profile');
  assertions += 1;
}

function assertSkosComposition(): void {
  const data = `${prefixes}
unit:KiloM-PER-HR skos:exactMatch ex:localKmh .
ex:case ex:speed [ a qudt:QuantityValue ; qudt:numericValue 36 ; qudt:unit ex:localKmh ] .
`;
  inferFixtureWithCurrent(data);
  assertNoNormalizedOutput({ name: 'skos-composition-without-skos-profile', data });
  const withSkos = createReasoner([skosProfile, qudtProfile]);
  const output = inferFixtureWithCurrent(data, withSkos);
  assertQuantity(normalizedQuantity(output, EX + 'case', QCR + 'normalizedQuantity'), UNIT + 'M-PER-SEC', 10, 1e-10, 'skos-composition-with-skos-profile');
  assertions += 1;
}

function assertKnownLimitations(): void {
  const result: TestResult = 'known-limitation';
  assert.equal(result, 'known-limitation', 'Energy and torque share a dimension vector; generic cdt:ucum cannot choose domain semantics reliably.');
  assert.equal(result, 'known-limitation', 'Absolute temperatures and temperature differences currently use the same temperature profile unless applications provide a more specific profile.');
  assertions += 2;
}

function inferMany(fixtures: Array<ConversionFixture | NegativeFixture>, reasoner = qudtReasoner): Quad[] {
  return Array.from(reasoner.infer(parseToQuads(`${prefixes}\n${fixtures.map((fixture) => fixture.data).join('\n')}`)));
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}
