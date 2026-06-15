import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Quad, Term } from '@rdfjs/types';
import { reasonStream, type RdfJsQuad } from 'eyeling';
import { DataFactory } from 'rdf-parser-ts';
import { parseRdf, termKey } from './utils';

const EX = 'https://example.org/manual-shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
const SHN = 'https://example.org/shacl-n3#';

const rules = readFileSync('rules/shacl-core-eyeling.n3', 'utf8');

const data = parseRdf(`
@prefix : <${EX}> .
@prefix sh: <${SH}> .

:Root a :Root, :ExpectedPathValue .

:step1 :p1 :Root .
:step2 :p2 :step1 .
:goodLeaf :p3 :step2 ; a :ExpectedLeaf .
:badLeaf :p3 :step2 .
:Root :altB :altValue ;
  :parent :chain1 ;
  :maybe :maybeValue .
:altValue a :ExpectedPathValue .
:chain1 a :ExpectedPathValue ;
  :parent :chain2 .
:chain2 a :ExpectedPathValue .
:maybeValue a :ExpectedPathValue .

:ThreeStepInverseShape a sh:NodeShape ;
  sh:targetNode :Root ;
  sh:path ( [ sh:inversePath :p1 ] [ sh:inversePath :p2 ] [ sh:inversePath :p3 ] ) ;
  sh:class :ExpectedLeaf .

:GenericPathShape a sh:NodeShape ;
  sh:targetNode :Root ;
  sh:property [
    sh:path [ sh:alternativePath ( :altA :altB ) ] ;
    sh:class :ExpectedPathValue
  ] ;
  sh:property [
    sh:path [ sh:zeroOrMorePath :parent ] ;
    sh:class :ExpectedPathValue
  ] ;
  sh:property [
    sh:path [ sh:oneOrMorePath :parent ] ;
    sh:class :ExpectedPathValue
  ] ;
  sh:property [
    sh:path [ sh:zeroOrOnePath :maybe ] ;
    sh:class :ExpectedPathValue
  ] .

:PatternFlagsShape a sh:NodeShape ;
  sh:targetNode :Root ;
  sh:property [
    sh:path :caseInsensitiveCode ;
    sh:pattern "^ABC$" ;
    sh:flags "i"
  ] ;
  sh:property [
    sh:path :multilineCode ;
    sh:pattern "^DEF$" ;
    sh:flags "m"
  ] ;
  sh:property [
    sh:path :dotAllCode ;
    sh:pattern "^a.b$" ;
    sh:flags "s"
  ] ;
  sh:property [
    sh:path :strictCode ;
    sh:pattern "^ABC$"
  ] .

:Root :caseInsensitiveCode "abc" ;
  :multilineCode """abc
DEF""" ;
  :dotAllCode """a
b""" ;
  :strictCode "abc" .
`);

const closure = reasonStream({ n3: rules, quads: data as RdfJsQuad[] }, {
  rdfjs: true,
  dataFactory: DataFactory,
  skipUnsupportedRdfJs: true,
} as any).closureQuads as Quad[] ?? [];

const resultSubjects = uniqueTerms(closure
  .filter((quad) => isNamed(quad.predicate as Term, RDF + 'type') && isNamed(quad.object as Term, SH + 'ValidationResult'))
  .map((quad) => quad.subject as Term));

const classResults = resultSubjects.filter((result) => hasObject(result, SH + 'sourceConstraintComponent', SH + 'ClassConstraintComponent'));
const patternResults = resultSubjects.filter((result) => hasObject(result, SH + 'sourceConstraintComponent', SH + 'PatternConstraintComponent'));
const pathValueObjects = new Set(closure
  .filter((quad) => isNamed(quad.predicate as Term, SHN + 'pathValue'))
  .map((quad) => termKey(quad.object as Term)));

assert.equal(classResults.length, 1, 'three-step inverse sequence should produce exactly one class violation');
assert.ok(hasObject(classResults[0], SH + 'focusNode', EX + 'Root'), 'class violation should focus :Root');
assert.ok(hasObject(classResults[0], SH + 'value', EX + 'badLeaf'), 'class violation should be for the non-conforming leaf');
assert.ok(!hasObject(classResults[0], SH + 'value', EX + 'step2'), 'three-step path must not also validate the two-step prefix');

assert.ok(pathValueObjects.has(termKey(DataFactory.namedNode(EX + 'altValue'))), 'alternative paths should resolve values from any alternative');
assert.ok(pathValueObjects.has(termKey(DataFactory.namedNode(EX + 'chain2'))), 'zero-or-more and one-or-more paths should resolve transitive values');
assert.ok(pathValueObjects.has(termKey(DataFactory.namedNode(EX + 'maybeValue'))), 'zero-or-one paths should resolve the optional value');

assert.equal(patternResults.length, 1, 'pattern validation should produce exactly one violation');
assert.ok(hasObject(patternResults[0], SH + 'resultPath', EX + 'strictCode'), 'unflagged strict pattern should still fail');
assert.ok(!patternResults.some((result) => hasObject(result, SH + 'resultPath', EX + 'caseInsensitiveCode')), 'sh:flags "i" should make the pattern match case-insensitively');
assert.ok(!patternResults.some((result) => hasObject(result, SH + 'resultPath', EX + 'multilineCode')), 'sh:flags "m" should enable multiline anchors');
assert.ok(!patternResults.some((result) => hasObject(result, SH + 'resultPath', EX + 'dotAllCode')), 'sh:flags "s" should let dot match newlines');

console.log('Manual SHACL regression tests passed: 3-step inverse sequence and sh:pattern flags.');

function hasObject(subject: Term, predicate: string, objectValue: string): boolean {
  return closure.some((quad) => termKey(quad.subject as Term) === termKey(subject)
    && isNamed(quad.predicate as Term, predicate)
    && isNamed(quad.object as Term, objectValue));
}

function isNamed(term: Term, value: string): boolean {
  return term.termType === 'NamedNode' && term.value === value;
}

function uniqueTerms(terms: Term[]): Term[] {
  const byKey = new Map<string, Term>();
  for (const term of terms) {
    byKey.set(termKey(term), term);
  }
  return Array.from(byKey.values());
}
