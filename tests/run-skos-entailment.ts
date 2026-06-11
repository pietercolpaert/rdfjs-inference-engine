import { readFileSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine } from '../src';
import { graphContainsAll, parseRdf } from './utils';

interface SkosTestCase {
  id: string;
  description: string;
  input: string;
  expected?: string;
  notExpected?: string;
}

interface TestResult {
  id: string;
  ok: boolean;
  error?: string;
}

const PREFIXES = `
@prefix ex: <https://example.org/skos-test#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
`;

const TESTS: SkosTestCase[] = [
  {
    id: 'concept-scheme-top-concept',
    description: 'S4-S8: topConceptOf entails inScheme, inverse hasTopConcept, and scheme/concept typing.',
    input: `
      ex:animals skos:topConceptOf ex:scheme .
    `,
    expected: `
      ex:animals skos:inScheme ex:scheme .
      ex:scheme skos:hasTopConcept ex:animals .
      ex:scheme a skos:ConceptScheme .
      ex:animals a skos:Concept .
    `,
  },
  {
    id: 'labels-and-notes',
    description: 'S11 and S17: SKOS labels and note refinements materialize their super-properties.',
    input: `
      ex:animals skos:prefLabel "animals" ;
        skos:altLabel "fauna" ;
        skos:hiddenLabel "aminals" ;
        skos:definition "Living organisms that feed on organic matter." ;
        skos:scopeNote "Use for the general concept." .
    `,
    expected: `
      ex:animals rdfs:label "animals" .
      ex:animals rdfs:label "fauna" .
      ex:animals rdfs:label "aminals" .
      ex:animals skos:note "Living organisms that feed on organic matter." .
      ex:animals skos:note "Use for the general concept." .
    `,
  },
  {
    id: 'semantic-relations',
    description: 'S19-S26: broader/narrower inverses, transitive super-properties, related symmetry, and Concept typing.',
    input: `
      ex:cat skos:broader ex:mammal .
      ex:mammal skos:broader ex:animal .
      ex:cat skos:related ex:pet .
    `,
    expected: `
      ex:cat skos:broaderTransitive ex:mammal .
      ex:mammal skos:narrower ex:cat .
      ex:cat skos:broaderTransitive ex:animal .
      ex:animal skos:narrowerTransitive ex:cat .
      ex:cat skos:semanticRelation ex:animal .
      ex:pet skos:related ex:cat .
      ex:cat a skos:Concept .
      ex:mammal a skos:Concept .
      ex:animal a skos:Concept .
      ex:pet a skos:Concept .
    `,
    notExpected: `
      ex:cat skos:broader ex:animal .
    `,
  },
  {
    id: 'ordered-collection-members',
    description: 'S29-S36: memberList entails OrderedCollection/Collection typing and skos:member for every list item.',
    input: `
      ex:domesticAnimals skos:memberList ( ex:cat ex:dog ex:horse ) .
    `,
    expected: `
      ex:domesticAnimals a skos:OrderedCollection .
      ex:domesticAnimals a skos:Collection .
      ex:domesticAnimals skos:member ex:cat .
      ex:domesticAnimals skos:member ex:dog .
      ex:domesticAnimals skos:member ex:horse .
    `,
    notExpected: `
      ex:cat a skos:Concept .
    `,
  },
  {
    id: 'mapping-property-hierarchy',
    description: 'S39-S44: mapping properties materialize hierarchy, inverse, symmetry, and Concept typing.',
    input: `
      ex:cat skos:broadMatch ex:feline .
      ex:cat skos:relatedMatch ex:petCat .
    `,
    expected: `
      ex:cat skos:mappingRelation ex:feline .
      ex:cat skos:broader ex:feline .
      ex:feline skos:narrowMatch ex:cat .
      ex:cat skos:broaderTransitive ex:feline .
      ex:cat skos:semanticRelation ex:feline .
      ex:petCat skos:relatedMatch ex:cat .
      ex:cat skos:related ex:petCat .
      ex:petCat skos:related ex:cat .
      ex:cat a skos:Concept .
      ex:feline a skos:Concept .
      ex:petCat a skos:Concept .
    `,
  },
  {
    id: 'exact-match-transitivity',
    description: 'S42-S45: exactMatch is symmetric/transitive and is a sub-property of closeMatch.',
    input: `
      ex:a skos:exactMatch ex:b .
      ex:b skos:exactMatch ex:c .
    `,
    expected: `
      ex:b skos:exactMatch ex:a .
      ex:a skos:exactMatch ex:c .
      ex:c skos:exactMatch ex:a .
      ex:a skos:closeMatch ex:c .
      ex:a skos:closeMatch ex:a .
      ex:a skos:mappingRelation ex:c .
      ex:a a skos:Concept .
      ex:c a skos:Concept .
    `,
  },
  {
    id: 'close-match-not-transitive',
    description: 'Section 10.6.3: closeMatch is symmetric but not transitive.',
    input: `
      ex:a skos:closeMatch ex:b .
      ex:b skos:closeMatch ex:c .
    `,
    expected: `
      ex:b skos:closeMatch ex:a .
      ex:c skos:closeMatch ex:b .
    `,
    notExpected: `
      ex:a skos:closeMatch ex:c .
    `,
  },
  {
    id: 'scheme-containment-non-entailment',
    description: 'Section 4.6.4: semantic relations do not imply membership in the same concept scheme.',
    input: `
      ex:a skos:narrower ex:b .
      ex:a skos:inScheme ex:scheme .
    `,
    expected: `
      ex:b skos:broader ex:a .
      ex:scheme a skos:ConceptScheme .
    `,
    notExpected: `
      ex:b skos:inScheme ex:scheme .
    `,
  },
];

function main(): void {
  const profile = readFileSync('rules/skos-entailment.n3', 'utf8');
  const prepared = new InferenceEngine();
  prepared.load(profile, []);
  const runtime = prepared.getRuntime();

  const results: TestResult[] = [];

  for (const test of TESTS) {
    try {
      const premise = parse(PREFIXES + test.input);
      const reasoner = new InferenceEngine({ runtime });
      const closure = [...premise, ...reasoner.infer(premise)];
      const expectedOk = test.expected ? graphContainsAll(closure, parse(PREFIXES + test.expected)) : true;
      const notExpectedOk = test.notExpected ? !graphContainsAll(closure, parse(PREFIXES + test.notExpected)) : true;
      const ok = expectedOk && notExpectedOk;

      results.push({ id: test.id, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${test.id}: ${test.description}`);
      if (!ok) {
        if (!expectedOk) {
          console.log(`  Missing expected entailment(s).`);
        }
        if (!notExpectedOk) {
          console.log(`  Derived non-entailment guard triple(s).`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: test.id, ok: false, error: message });
      console.log(`ERROR ${test.id}: ${message}`);
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`SKOS Core entailment tests: ${passed}/${results.length} passed.`);

  if (failed > 0) {
    throw new Error(`${failed} SKOS Core entailment test(s) failed.`);
  }
}

function parse(source: string): Quad[] {
  return parseRdf(source);
}

main();
