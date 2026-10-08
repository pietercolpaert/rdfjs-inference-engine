import assert from 'node:assert/strict';
import type { Quad } from '@rdfjs/types';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { Parser as SparqlParser } from 'sparqljs';
import { reasonStream } from 'eyeling';
import { InferenceEngine, translateN3RuntimeToSparql, executeSparqlRuntime, createRdfjsSparqlExecutor } from '../src';
const { Parser, Writer } = require('n3');
const prefixes = `@prefix ex:<urn:ex:>. @prefix math:<http://www.w3.org/2000/10/swap/math#>.
@prefix log:<http://www.w3.org/2000/10/swap/log#>. @prefix string:<http://www.w3.org/2000/10/swap/string#>.
@prefix dt:<https://eyereasoner.github.io/eyeling/datatype#>. @prefix xsd:<http://www.w3.org/2001/XMLSchema#>.\n`;
const parse = (source: string): Quad[] => new Parser({ format: 'N3' }).parse(prefixes + source);
const executor = createRdfjsSparqlExecutor(new QueryEngine());
const key = (q: Quad) => new Writer({ format: 'N-Triples' }).quadsToString([q]);
async function run(runtime: string, data: string, maxRounds?: number) {
  const compiled = translateN3RuntimeToSparql(prefixes + runtime);
  assert.ok(compiled.program, JSON.stringify(compiled.diagnostics));
  for (const query of [compiled.program.seedQuery, ...compiled.program.rules.map(r => r.query)]) if (query) assert.equal((new SparqlParser().parse(query) as any).queryType, 'CONSTRUCT');
  return executeSparqlRuntime(compiled.program, parse(data), executor, { maxRounds });
}
async function main() {
  const rules = `
ex:factor ex:amount 2.0.
{ ?s ex:result ?v } => { ?s ex:final ?v }.
{ ?s ex:input ?x. ex:factor ex:amount ?factor. (?x ?factor) math:product ?y } => { ?s ex:result ?y }.
{ ?s ex:edge ?o } => { ?s ex:reach ?o }.
{ ?s ex:reach ?m. ?m ex:edge ?o } => { ?s ex:reach ?o }.
`;
  const data = 'ex:s ex:input 3.0; ex:edge ex:m. ex:m ex:edge ex:n.';
  const result = await run(rules, data);
  assert.ok(result.rounds >= 3, 'Reverse-order chaining needs multiple rounds.');
  assert.ok(result.output.some(q => q.predicate.value === 'urn:ex:final' && Number(q.object.value) === 6));
  assert.ok(result.output.some(q => q.predicate.value === 'urn:ex:reach' && q.object.value === 'urn:ex:n'));
  const eyeling: Quad[] = [];
  reasonStream(prefixes + rules + data, { rdfjs: true, onDerived: item => { if (item.quad) eyeling.push(item.quad); } });
  assert.deepEqual(new Set(result.derived.map(key)), new Set(eyeling.map(key)), 'Supported N3 output agrees with Eyeling.');
  const helper = await run(`
{ (?x ?factor) ex:scaled ?y } <= { (?x ?factor) math:product ?y }.
{ ?s ex:input ?x. (?x 4.0) ex:scaled ?y } => { ?s ex:result ?y }.
`, 'ex:s ex:input 2.0.');
  assert.equal(Number(helper.output[0].object.value), 8, 'Backward list helpers are inlined.');
  const alternative = await run(`
{ ?s ex:value ?v } <= { ?s ex:a ?v }.
{ ?s ex:value ?v } <= { ?s ex:b ?v }.
{ ?s ex:value ?v } => { ?s ex:result ?v }.
`, 'ex:s ex:a 1; ex:b 2.');
  assert.equal(alternative.output.length, 2, 'Backward clauses become UNION branches.');
  const helperFacts = await run(`
{ ?s ex:value ?v } <= { ?s ex:a ?v }.
{ ?s ex:value ?v } => { ?s ex:result ?v }.
`, 'ex:s ex:a 1; ex:value 2.');
  assert.equal(helperFacts.output.length, 2, 'Backward relations still admit explicit RDF facts.');
  const hygiene = await run(`
{ (?x ?f) ex:scaled ?y } <= { (?x ?f) math:product ?y. (?x 100) math:sum ?temp }.
{ ?s ex:input ?x; ex:constraint ?__n3_helper_1_temp. (?x 2) ex:scaled ?y } => { ?s ex:result ?y }.
`, 'ex:s ex:input 2; ex:constraint 0.');
  assert.equal(Number(hygiene.output[0].object.value), 4, 'Helper locals cannot capture source variables.');
  const builtins = await run(`
{ ?s ex:input ?x. (?difference 2.0) math:quotient ?quotient.
  (?x 2.0) math:sum ?sum. (?sum 1.0) math:difference ?difference.
  ?quotient math:greaterThan 1.0. ?quotient math:floor ?floor.
  ("item-" "label") string:concatenation ?label. ?label string:startsWith "item".
  ?label dt:datatype ?datatype. ?x dt:lexicalForm ?lexical.
  (?lexical xsd:decimal) log:dtlit ?literal.
} => { ?s ex:floor ?floor; ex:label ?label; ex:datatype ?datatype; ex:literal ?literal }.
`, 'ex:s ex:input 5.0.');
  assert.equal(builtins.output.length, 4, 'Arithmetic, strings, datatype inspection and dependency ordering.');
  assert.ok(builtins.output.some(q => q.predicate.value === 'urn:ex:floor' && Number(q.object.value) === 3));
  const rounding = await run('{ ?s ex:input ?x. ?x math:rounded ?y } => { ?s ex:result ?y }.', 'ex:s ex:input -1.5.');
  const rounded = rounding.output[0].object;
  assert.equal(Number(rounded.value), -1);
  assert.equal(rounded.termType === 'Literal' && rounded.datatype.value, 'http://www.w3.org/2001/XMLSchema#integer');
  const failedBind = await run('{ ?s ex:input ?x. (?x 2) math:product ?y } => { ?s ex:success true }.', 'ex:s ex:input "not numeric".');
  assert.equal(failedBind.output.length, 0, 'A failed built-in removes the solution even if its output is absent from the head.');
  const invalidLexical = await run('{ ?s ex:input ?x. ?x dt:lexicalForm ?lexical } => { ?s ex:result ?lexical }.', 'ex:s ex:input ex:iri.');
  assert.equal(invalidLexical.output.length, 0, 'Datatype lexicalForm accepts literals only.');
  const blanks = await run('{ ?s ex:input ?o } => { ?s ex:result ?o }.', '_:message ex:input _:value.');
  assert.equal(blanks.rounds, 2);
  assert.equal(blanks.output[0].subject.value, blanks.closure.find(q => q.predicate.value === 'urn:ex:input')!.subject.value, 'Blank node identity survives reinsertion.');
  const anonymousPattern = await run('{ ?s ex:input [ ex:label ?v ] } => { ?s ex:result ?v }.', 'ex:s ex:input [ ex:label "value" ].');
  assert.equal(anonymousPattern.output[0].object.value, 'value');
  const negation = await run('{ ?s ex:input ?o. 1 log:notIncludes { ?s ex:blocked true } } => { ?s ex:result ?o }.', 'ex:a ex:input 1. ex:b ex:input 2; ex:blocked true.');
  assert.equal(negation.output.length, 1);
  for (const runtime of [
    '{ ?s ex:input ?x. (?x 2) math:exponentiation ?y } => { ?s ex:result ?y }.',
    '{ ?s ex:input ?x } => { ?s ex:result ?unbound }.',
    '{ ?s ex:input ?x } => { ?s ex:result [ ex:value ?x ] }.',
    '{ ?s ex:input ?x } => { ?x math:equalTo 1 }.',
    '{ ?s ex:helper ?o } <= { ?s ex:helper ?o }. { ?s ex:helper ?o } => { ?s ex:result ?o }.',
    '{ ?s ex:input ?x. (?unknown 2) math:product ?y } => { ?s ex:result ?y }.',
    '<urn:graph> { ex:s ex:input 1 }',
    'not N3',
  ]) {
    const compiled = translateN3RuntimeToSparql(prefixes + runtime);
    assert.equal(compiled.program, null, runtime);
    assert.ok(compiled.diagnostics.some(d => d.severity === 'error'));
  }
  const engine = new InferenceEngine({ runtime: prefixes + rules });
  assert.deepEqual(engine.getSparqlRuntime(), translateN3RuntimeToSparql(engine.getRuntime()), 'Engine convenience method translates its actual runtime.');
  const loaded = new InferenceEngine();
  loaded.load(prefixes + '{ ?s ex:input ?x. (?x 2) math:product ?y } => { ?s ex:result ?y }.', [], { selectRuntimeRules: false });
  assert.ok(loaded.getSparqlRuntime().program, JSON.stringify(loaded.getSparqlRuntime().diagnostics));
  const loadedOutput = await executeSparqlRuntime(loaded.getSparqlRuntime().program!, parse('ex:s ex:input 3.'), executor);
  assert.equal(Number(loadedOutput.output.find(q => q.predicate.value === 'urn:ex:result')!.object.value), 6);
  await assert.rejects(() => run('{ ?s ex:input ?x. (?x 1) math:sum ?y } => { ?s ex:input ?y }.', 'ex:s ex:input 1.', 3), /did not converge/);
  const tiny = translateN3RuntimeToSparql(prefixes + rules).program!;
  await assert.rejects(() => executeSparqlRuntime(tiny, parse(data), executor, { maxFacts: 1 }), /exceeded/);
  console.log('N3 → SPARQL: Eyeling parity, built-ins, helpers, recursion, identity, diagnostics and runtime integration verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
