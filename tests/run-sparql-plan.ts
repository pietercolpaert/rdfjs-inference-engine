import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parser } from 'rdf-parser-ts';
import type { Quad } from '@rdfjs/types';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';
import { createRdfjsSparqlExecutor, executeSparqlRuntime, generateSparqlConstruct, translateN3RuntimeToSparql } from '../src';
import { optimizeSparqlPlan } from '../src/sparql-plan';

const parse = (text: string): Quad[] => new Parser().parse(text) as Quad[];
const prefixes = '@prefix ex: <urn:ex:>. @prefix math: <http://www.w3.org/2000/10/swap/math#>. @prefix log: <http://www.w3.org/2000/10/swap/log#>.\n';
const executor = createRdfjsSparqlExecutor(new QueryEngine());
const keys = (quads: Quad[]) => new Set(quads.map(q => JSON.stringify([q.subject, q.predicate, q.object, q.graph].map(t =>
  t.termType === 'Literal' ? [t.termType, t.value, t.language, t.datatype.value] : [t.termType, t.value]))));
const projection = 'CONSTRUCT { ?s <urn:ex:result> ?o } WHERE { ?s <urn:ex:result> ?o }';

async function compare(source: string, input: string, closure = false) {
  const translated = translateN3RuntimeToSparql(prefixes + source);
  assert.ok(translated.program, JSON.stringify(translated.diagnostics));
  if (closure) translated.program.projectionSource = 'closure';
  const optimized = optimizeSparqlPlan(translated.program, projection);
  const data = parse(prefixes + input);
  const reference = await executeSparqlRuntime(translated.program, data, executor, { outputQuery: projection });
  // Round-trip the artifact: execution must not retain compiler state or N3.
  const program = JSON.parse(JSON.stringify(optimized.program));
  const actual = await executeSparqlRuntime(program, data, executor, { outputQuery: optimized.query });
  assert.deepEqual(keys(actual.output), keys(reference.output));
  if (!optimized.standalone) {
    assert.deepEqual(keys(actual.closure), keys(reference.closure));
    assert.deepEqual(keys(actual.derived), keys(reference.derived));
  } else assert.deepEqual(keys(Array.from(await executor(optimized.query, data))), keys(reference.output), 'Standalone query needs only input RDF.');
  return { optimized, reference, actual };
}

async function main() {
  const one = await compare(`ex:factor ex:value 0.01.
{ ?s ex:input ?x. ex:factor ex:value ?f. (?x ?f) math:product ?y } => { ?s ex:middle ?y }.
{ ?s ex:middle ?y } => { ?s ex:result ?y }.`, 'ex:a ex:input 32. ex:b ex:result 7.', true);
  assert.equal(one.optimized.standalone, true);
  assert.equal(one.optimized.program.rules.length, 0);
  assert.equal(one.optimized.program.seedQuery, null);

  const constants = await compare('{ ?s ex:input ?x } => { ex:fixed ex:middle ?x. ?s ex:middle ?x }.\n{ ?s ex:middle ?x } => { ?s ex:result ?x }.', 'ex:a ex:input 3. ex:b ex:input 4.', true);
  assert.equal(constants.optimized.standalone, true, 'Constant and multi-triple heads unfold.');
  const hygiene = await compare('{ ?s ex:input ?__view_1 } => { ?s ex:result ?__view_1 }.', '_:a ex:input _:b.', true);
  assert.equal(hygiene.optimized.standalone, true, 'Fresh variables and input blank nodes retain identity.');

  const recursive = await compare(`
{ ?s ex:edge ?o } => { ?s ex:result ?o }.
{ ?s ex:result ?m. ?m ex:edge ?o } => { ?s ex:result ?o }.`, 'ex:a ex:edge ex:b. ex:b ex:edge ex:c. ex:c ex:edge ex:d.', true);
  assert.equal(recursive.optimized.standalone, false);
  assert.equal(recursive.optimized.program.rules.length, 1, 'Positive recursive queries fuse into one iterative CONSTRUCT.');
  assert.ok(recursive.actual.rounds >= 3);

  const helper = await compare(`
{ ?s ex:value ?x } <= { ?s ex:a ?x }.
{ ?s ex:value ?x } <= { ?s ex:b ?x }.
{ ?s ex:value ?x } => { ?s ex:result ?x }.`, 'ex:a ex:a 1; ex:b 2; ex:value 3.');
  assert.equal(helper.optimized.program.rules.length, 1, 'Private helper views disappear.');
  assert.equal(helper.optimized.program.auxiliaryGraphs?.length, 0);

  const negative = await compare(`
{ ?s ex:input ?x } => { ?s ex:middle ?x }.
{ ?s ex:middle ?x } => { ?s ex:absent ?x }.
{ ?s ex:input ?x. 1 log:notIncludes { ?s ex:absent ?x } } => { ?s ex:result ?x }.`, 'ex:a ex:input 1.', true);
  assert.equal(negative.optimized.standalone, false);
  assert.equal(negative.optimized.program.rules.length, negative.optimized.originalRules, 'Eager current-store negation keeps rule visibility and order.');

  for (const name of ['qudt-museum-dimensions', 'nde-amsterdam-photograph', 'sensor-reading']) {
    const directory = `examples/sparql-construct/${name}/`;
    const inputs = { ontology: parse(readFileSync(directory + 'ontology.ttl', 'utf8')),
      shaclIn: parse(readFileSync(directory + 'shapes-in.ttl', 'utf8')),
      shaclOut: parse(readFileSync(directory + 'shapes-out.ttl', 'utf8')) };
    const original = generateSparqlConstruct({ ...inputs, optimize: false });
    const optimized = generateSparqlConstruct(inputs);
    assert.ok(original.program && original.query && optimized.program && optimized.query);
    assert.ok(optimized.program.rules.length < original.program.rules.length, `${name} reduces the query count.`);
    if (name === 'nde-amsterdam-photograph') assert.equal(optimized.standalone, true);
    if (name === 'qudt-museum-dimensions') {
      const data = parse(`@prefix ex: <urn:ex:>. @prefix qudt: <http://qudt.org/schema/qudt/>. @prefix unit: <http://qudt.org/vocab/unit/>.
@prefix museum: <https://example.org/museum/ontology#>.
ex:h a museum:RecordedHeight, qudt:QuantityValue; museum:heightOf ex:object; qudt:numericValue 32.0; qudt:unit unit:CentiM.`);
      const baseline = await executeSparqlRuntime(original.program, data, executor, { outputQuery: original.query });
      // Optimize the same prepared runtime so Eyeling's load-time allocations
      // cannot differ between the two background graphs being compared.
      const sameRuntime = optimizeSparqlPlan(original.program, original.query);
      const result = await executeSparqlRuntime(JSON.parse(JSON.stringify(sameRuntime.program)), data, executor, { outputQuery: sameRuntime.query });
      assert.deepEqual(keys(result.output), keys(baseline.output));
      assert.deepEqual(keys(result.closure), keys(baseline.closure));
    }
  }
  console.log('SPARQL plans: standalone unfolding, helper reduction, fusion, recursive fixed points and reference parity verified.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
