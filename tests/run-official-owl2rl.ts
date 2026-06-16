import { readFileSync } from 'node:fs';
import type { Quad } from '@rdfjs/types';
import { InferenceEngine } from '../src';
import { addReflexiveSameAsClosure, graphContainsAll, parseRdfXml, readCachedUrl } from './utils';

const TEST = 'http://www.w3.org/2007/OWL/testOntology#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const OWLRL = 'https://example.org/owlrl-n3#';
const DEFAULT_MANIFEST_BASE_URL = 'https://www.w3.org/';
const DEFAULT_CACHE_DIR = '.cache/owl2rl';
const DEFAULT_MANIFEST_PATHS = [
  '/2009/11/owl-test/profile-RL.rdf',
  '/2009/11/owl-test/RL-RDF-rules-tests.rdf',
  '/2009/11/owl-test/type-positive-entailment.rdf',
  '/2009/11/owl-test/type-negative-entailment.rdf',
  '/2009/11/owl-test/type-consistency.rdf',
  '/2009/11/owl-test/type-inconsistency.rdf',
  '/2009/11/owl-test/proposed/profile-RL.rdf',
  '/2009/11/owl-test/proposed/RL-RDF-rules-tests.rdf',
  '/2009/11/owl-test/proposed/type-positive-entailment.rdf',
  '/2009/11/owl-test/proposed/type-negative-entailment.rdf',
  '/2009/11/owl-test/proposed/type-consistency.rdf',
  '/2009/11/owl-test/proposed/type-inconsistency.rdf',
];

const DEFAULT_SUPPORTED_IDS = new Set([
  'WebOnt-equivalentClass-002',
  'WebOnt-equivalentClass-003',
  'WebOnt-equivalentClass-008',
  'WebOnt-equivalentProperty-002',
  'WebOnt-equivalentProperty-003',
  'WebOnt-sameAs-001',
  'WebOnt-I4.6-003',
  'WebOnt-I4.6-004',
  'WebOnt-I4.6-005',
  'WebOnt-I5.8-007',
  'FS2RDF-different-individuals-2-ar',
  'FS2RDF-no-builtin-prefixes-ar',
  'FS2RDF-same-individual-2-ar',
  'New-Feature-AnnotationAnnotations-001',
  'New-Feature-AxiomAnnotations-001',
  'owl2-rl-anonymous-individual',
  'owl2-rl-valid-rightside-allvaluesfrom',
  'WebOnt-AnnotationProperty-003',
  'WebOnt-AnnotationProperty-004',
  'WebOnt-backwardCompatibleWith-002',
  'WebOnt-miscellaneous-303',
  'DisjointClasses-002',
  'New-Feature-AsymmetricProperty-001',
  'New-Feature-DisjointDataProperties-001',
  'New-Feature-IrreflexiveProperty-001',
  'New-Feature-NegativeDataPropertyAssertion-001',
  'New-Feature-NegativeObjectPropertyAssertion-001',
  'WebOnt-description-logic-104',
  'WebOnt-Nothing-001',
]);

interface ManifestCase {
  iri: string;
  types: string[];
  identifier: string[];
  description: string[];
  status: string[];
  profile: string[];
  semantics: string[];
  rdfXmlPremiseOntology: string[];
  rdfXmlConclusionOntology: string[];
  rdfXmlNonConclusionOntology: string[];
}

interface TestResult {
  id: string;
  ok: boolean;
  kind: TestKind;
  error?: string;
}

type TestKind = 'positive' | 'negative' | 'consistency' | 'inconsistency';

interface RunnableTest extends ManifestCase {
  kind: TestKind;
}

interface ParsedArgs {
  all: boolean;
  list: boolean;
  conformance: boolean;
  ids?: Set<string>;
  manifests?: string[];
  cacheDir: string;
  kinds?: Set<TestKind>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestUrls = args.manifests ?? manifestsFromEnvironment() ?? DEFAULT_MANIFEST_PATHS.map(resolveManifestUrl);
  const manifestQuads = (await Promise.all(manifestUrls.map(async (manifestUrl) => {
    const cachePath = manifestCachePath(args.cacheDir, manifestUrl);
    const manifestText = await readCachedUrl(manifestUrl, cachePath);
    return parseRdfXml(manifestText, manifestUrl);
  }))).flat();
  const tests = extractRunnableCases(manifestQuads);
  const listedTests = args.kinds ? tests.filter((test) => args.kinds?.has(test.kind)) : tests;

  if (args.list) {
    for (const test of listedTests) {
      console.log(`${test.kind}\t${test.identifier[0]}\t${oneLine(test.description[0] ?? '')}`);
    }
    return;
  }

  const selectedIds = args.all
    ? new Set(listedTests.map((test) => test.identifier[0]))
    : args.ids ?? DEFAULT_SUPPORTED_IDS;
  const selected = listedTests.filter((test) => selectedIds.has(test.identifier[0]));

  if (selected.length === 0) {
    throw new Error('No official OWL 2 RL tests selected. Use --list to see discovered test identifiers.');
  }

  const profile = readFileSync('rules/owl2rl-eyeling.n3', 'utf8');
  const outputMode = args.conformance || args.all ? 'conformance' : 'application';
  const prepared = new InferenceEngine({ outputMode });
  prepared.load(profile, [], { selectRuntimeRules: false });
  const runtime = prepared.getRuntime();
  const staticClosure = outputMode === 'conformance' ? prepared.getStaticClosure({ outputMode }) : [];

  const results: TestResult[] = [];
  for (const test of selected) {
    const id = test.identifier[0];
    try {
      const premiseBaseIri = `${test.iri}/premise`;
      const premise = await expandImports(
        await parseRdfXml(test.rdfXmlPremiseOntology[0], premiseBaseIri),
        args.cacheDir,
        outputMode === 'conformance' ? new Set<string>([premiseBaseIri]) : undefined,
      );
      const inferenceOutputMode = outputMode === 'conformance' ? 'application' : outputMode;
      const reasoner = new InferenceEngine({ runtime, outputMode: inferenceOutputMode });
      const inference = reasoner.inferWithDiagnostics(premise, { outputMode: inferenceOutputMode });
      const diagnosticQuads = inference.inconsistencies.flatMap((report) => report.quads);
      const rawClosure = [...staticClosure, ...premise, ...inference.quads, ...diagnosticQuads];
      const closure = outputMode === 'conformance' ? addReflexiveSameAsClosure(rawClosure) : rawClosure;

      const ok = await evaluateTest(test, closure);
      results.push({ id, kind: test.kind, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${test.kind} ${id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id, kind: test.kind, ok: false, error: message });
      console.log(`ERROR ${test.kind} ${id}: ${message}`);
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`Official OWL 2 RL RDF/XML tests: ${passed}/${results.length} passed.`);

  if (failed > 0) {
    throw new Error(`${failed} selected official OWL 2 RL test(s) failed.`);
  }
}

async function evaluateTest(test: RunnableTest, closure: Quad[]): Promise<boolean> {
  if (test.kind === 'positive') {
    const conclusion = await parseRdfXml(test.rdfXmlConclusionOntology[0], `${test.iri}/conclusion`);
    if (hasAllDifferentConclusion(conclusion)) {
      return allDifferentConclusionsSatisfied(closure, conclusion);
    }
    return graphContainsAll(closure, conclusion);
  }

  if (test.kind === 'negative') {
    const nonConclusion = await parseRdfXml(test.rdfXmlNonConclusionOntology[0], `${test.iri}/non-conclusion`);
    return !graphContainsAll(closure, nonConclusion);
  }

  if (test.kind === 'consistency') {
    return !hasInconsistencyDiagnostic(closure);
  }

  return hasInconsistencyDiagnostic(closure);
}

function hasAllDifferentConclusion(conclusion: Quad[]): boolean {
  return conclusion.some((quad) => (
    quad.predicate.value === RDF + 'type'
    && quad.object.termType === 'NamedNode'
    && quad.object.value === OWL + 'AllDifferent'
  ));
}

function allDifferentConclusionsSatisfied(closure: Quad[], conclusion: Quad[]): boolean {
  const differentPairs = new Set<string>();
  for (const quad of closure) {
    if (quad.predicate.value === OWL + 'differentFrom') {
      differentPairs.add(`${quad.subject.value}\u0000${quad.object.value}`);
      differentPairs.add(`${quad.object.value}\u0000${quad.subject.value}`);
    }
  }

  for (const members of allDifferentMemberLists(conclusion)) {
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        if (!differentPairs.has(`${members[left]}\u0000${members[right]}`)) {
          return false;
        }
      }
    }
  }

  return true;
}

function allDifferentMemberLists(conclusion: Quad[]): string[][] {
  const firstByListNode = new Map<string, string>();
  const restByListNode = new Map<string, string>();
  const lists: string[][] = [];

  for (const quad of conclusion) {
    if (quad.subject.termType === 'BlankNode' && quad.predicate.value === RDF + 'first' && quad.object.termType === 'NamedNode') {
      firstByListNode.set(quad.subject.value, quad.object.value);
    } else if (quad.subject.termType === 'BlankNode' && quad.predicate.value === RDF + 'rest') {
      restByListNode.set(quad.subject.value, quad.object.value);
    }
  }

  for (const quad of conclusion) {
    if (quad.predicate.value === OWL + 'members' && quad.object.termType === 'BlankNode') {
      const members: string[] = [];
      let listNode = quad.object.value;
      const visited = new Set<string>();
      while (!visited.has(listNode) && firstByListNode.has(listNode)) {
        visited.add(listNode);
        members.push(firstByListNode.get(listNode)!);
        const rest = restByListNode.get(listNode);
        if (!rest || rest === RDF + 'nil') {
          break;
        }
        listNode = rest;
      }
      lists.push(members);
    }
  }

  return lists;
}

async function expandImports(quads: Quad[], cacheDir: string, visited?: Set<string>): Promise<Quad[]> {
  if (!visited) {
    return quads;
  }

  const expanded = [...quads];
  const imports = quads
    .filter((quad) => quad.predicate.value === OWL + 'imports' && quad.object.termType === 'NamedNode')
    .map((quad) => quad.object.value);

  for (const importUrl of imports) {
    if (visited.has(importUrl)) {
      continue;
    }
    visited.add(importUrl);
    const imported = await parseRdfXml(await readCachedUrl(downloadUrl(importUrl), manifestCachePath(cacheDir, importUrl)), importUrl);
    expanded.push(...await expandImports(imported, cacheDir, visited));
  }

  return expanded;
}

function downloadUrl(url: string): string {
  return url.replace(/^http:\/\/www\.w3\.org\//, 'https://www.w3.org/');
}

function hasInconsistencyDiagnostic(quads: Quad[]): boolean {
  return quads.some((quad) => (
    quad.predicate.value === RDF + 'type'
    && quad.object.termType === 'NamedNode'
    && quad.object.value === OWLRL + 'Inconsistency'
  ));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { all: false, list: false, conformance: false, cacheDir: process.env.OWL2_TEST_MANIFEST_CACHE_DIR ?? DEFAULT_CACHE_DIR };

  for (const arg of args) {
    if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--conformance') {
      parsed.conformance = true;
    } else if (arg === '--list') {
      parsed.list = true;
    } else if (arg.startsWith('--ids=')) {
      parsed.ids = new Set(arg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean));
    } else if (arg.startsWith('--manifest=')) {
      parsed.manifests = arg.slice('--manifest='.length).split(',').map(resolveManifestUrl);
    } else if (arg.startsWith('--manifests=')) {
      parsed.manifests = arg.slice('--manifests='.length).split(',').map(resolveManifestUrl);
    } else if (arg.startsWith('--cache-dir=')) {
      parsed.cacheDir = arg.slice('--cache-dir='.length);
    } else if (arg.startsWith('--kinds=')) {
      parsed.kinds = new Set(arg.slice('--kinds='.length).split(',').map(parseKind));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function extractRunnableCases(quads: Quad[]): RunnableTest[] {
  const cases = new Map<string, ManifestCase>();

  for (const quad of quads) {
    if (quad.subject.termType !== 'NamedNode') {
      continue;
    }

    const iri = quad.subject.value;
    const testCase = cases.get(iri) ?? {
      iri,
      types: [],
      identifier: [],
      description: [],
      status: [],
      profile: [],
      semantics: [],
      rdfXmlPremiseOntology: [],
      rdfXmlConclusionOntology: [],
      rdfXmlNonConclusionOntology: [],
    };
    cases.set(iri, testCase);

    if (quad.predicate.value === RDF + 'type' && quad.object.termType === 'NamedNode') {
      testCase.types.push(quad.object.value);
    } else if (quad.predicate.termType === 'NamedNode' && quad.predicate.value.startsWith(TEST)) {
      const property = quad.predicate.value.slice(TEST.length) as keyof ManifestCase;
      const value = quad.object.value;
      if (Array.isArray(testCase[property])) {
        (testCase[property] as string[]).push(value);
      }
    }
  }

  return Array.from(cases.values())
    .filter((test) => test.status.includes(TEST + 'Approved') || test.status.includes(TEST + 'Proposed'))
    .filter((test) => test.profile.includes(TEST + 'RL'))
    .filter((test) => test.semantics.includes(TEST + 'RDF-BASED'))
    .map((test) => ({ ...test, kind: testKind(test) }))
    .filter((test): test is RunnableTest => test.kind !== undefined)
    .sort((left, right) => left.identifier[0].localeCompare(right.identifier[0]));
}

function testKind(test: ManifestCase): TestKind | undefined {
  if (test.types.includes(TEST + 'PositiveEntailmentTest') && test.rdfXmlPremiseOntology.length > 0 && test.rdfXmlConclusionOntology.length > 0) {
    return 'positive';
  }
  if (test.types.includes(TEST + 'NegativeEntailmentTest') && test.rdfXmlPremiseOntology.length > 0 && test.rdfXmlNonConclusionOntology.length > 0) {
    return 'negative';
  }
  if (test.types.includes(TEST + 'ConsistencyTest') && !test.types.includes(TEST + 'PositiveEntailmentTest') && !test.types.includes(TEST + 'NegativeEntailmentTest') && test.rdfXmlPremiseOntology.length > 0) {
    return 'consistency';
  }
  if (test.types.includes(TEST + 'InconsistencyTest') && test.rdfXmlPremiseOntology.length > 0) {
    return 'inconsistency';
  }
  return undefined;
}

function manifestsFromEnvironment(): string[] | undefined {
  const value = process.env.OWL2_TEST_MANIFEST_URLS ?? process.env.OWL2_TEST_MANIFEST_URL;
  return value ? value.split(',').map(resolveManifestUrl) : undefined;
}

function resolveManifestUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed;
  }
  return new URL(trimmed.replace(/^\//, ''), DEFAULT_MANIFEST_BASE_URL).toString();
}

function manifestCachePath(cacheDir: string, manifestUrl: string): string {
  const pathname = new URL(manifestUrl).pathname.replace(/^\//, '');
  return `${cacheDir}/${pathname}`;
}

function parseKind(value: string): TestKind {
  const trimmed = value.trim() as TestKind;
  if (trimmed === 'positive' || trimmed === 'negative' || trimmed === 'consistency' || trimmed === 'inconsistency') {
    return trimmed;
  }
  throw new Error(`Unknown test kind: ${value}`);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
