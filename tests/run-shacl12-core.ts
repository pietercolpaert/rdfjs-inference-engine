import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'rdf-parser-ts';
import { reasonStream, type RdfJsQuad } from 'eyeling';
import { parseRdfWithBase, readCachedUrl, termKey } from './utils';

const RAW_BASE = 'https://raw.githubusercontent.com/w3c/data-shapes/gh-pages/shacl12-test-suite/tests/core/';
const CACHE_ROOT = resolve('.cache/shacl12-test-suite/core');
const SHACL_RULES_PATHS = [
  resolve('rules/shacl-core-eyeling.n3'),
  resolve('rules/shacl12-core-eyeling.n3'),
];

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const SH = 'http://www.w3.org/ns/shacl#';
const SHT = 'http://www.w3.org/ns/shacl-test#';
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const DEFAULT_CONFORMANCE_DISALLOWS = new Set([SH + 'Violation', SH + 'Warning', SH + 'Info']);

const MANIFESTS = [
  'targets/manifest.ttl',
  'node/manifest.ttl',
  'property/manifest.ttl',
  'path/manifest.ttl',
  'complex/manifest.ttl',
  'misc/manifest.ttl',
  'validation-reports/manifest.ttl',
];

interface CliOptions {
  manifests: string[];
  only: Set<string>;
}

interface TestCase {
  id: string;
  filePath: string;
  fileUrl: string;
  entry: Term;
  quads: Quad[];
  dataRefs: Term[];
  shapesRefs: Term[];
  expectedConforms: boolean;
  conformanceDisallows: Set<string>;
}

interface TestOutcome {
  test: TestCase;
  actualConforms: boolean;
  resultCount: number;
}

async function main(): Promise<void> {
  for (const rulePath of SHACL_RULES_PATHS) {
    assert.ok(existsSync(rulePath), `Expected ${rulePath} to exist.`);
  }

  const options = parseCliOptions(process.argv.slice(2));
  const testCases = await loadTestCases(options.manifests, options);
  const selected = testCases.filter((test) => shouldRunTest(test, options));

  const rules = SHACL_RULES_PATHS.map((rulePath) => readFileSync(rulePath, 'utf8')).join('\n\n');
  const outcomes: TestOutcome[] = [];
  const failures: string[] = [];

  for (const test of selected) {
    const dataAndShapes = await loadDataAndShapes(test);
    const outcome = runValidation(rules, test, dataAndShapes);
    outcomes.push(outcome);

    if (outcome.actualConforms !== test.expectedConforms) {
      failures.push(`${test.filePath} expected sh:conforms ${test.expectedConforms} but got ${outcome.actualConforms} (${outcome.resultCount} result(s))`);
    }
  }

  for (const outcome of outcomes) {
    const status = outcome.actualConforms === outcome.test.expectedConforms ? 'PASS' : 'FAIL';
    console.log(`${status} ${outcome.test.filePath} (${outcome.resultCount} result(s))`);
  }

  if (failures.length > 0) {
    console.error('\nSHACL 1.2 Core failures:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`SHACL 1.2 Core suite: ${outcomes.length}/${outcomes.length} W3C test file(s) matched sh:conforms.`);
}

function parseCliOptions(args: string[]): CliOptions {
  const manifests: string[] = [];
  const only = new Set<string>();

  for (const arg of args) {
    if (arg.startsWith('--manifest=')) {
      manifests.push(normalizeSuitePath(arg.slice('--manifest='.length)));
    } else if (arg.startsWith('--only=')) {
      for (const item of arg.slice('--only='.length).split(',')) {
        if (item.trim()) {
          only.add(normalizeSuitePath(item.trim()));
        }
      }
    } else {
      throw new Error(`Unknown SHACL 1.2 test option: ${arg}`);
    }
  }

  return {
    manifests: manifests.length > 0 ? manifests : MANIFESTS,
    only,
  };
}

async function loadTestCases(manifests: string[], options: CliOptions): Promise<TestCase[]> {
  const tests: TestCase[] = [];
  const seenFiles = new Set<string>();

  for (const manifestPath of manifests) {
    const manifest = await fetchSuiteFile(manifestPath);
    const manifestQuads = parseSuiteRdf(manifest.text, manifest.url);
    const includes = objects(manifestQuads, undefined, MF + 'include')
      .filter((term) => term.termType === 'NamedNode')
      .map((term) => suitePathFromUrl(term.value));

    for (const testFilePath of includes) {
      if (seenFiles.has(testFilePath)) {
        continue;
      }
      seenFiles.add(testFilePath);
      if (!shouldLoadTestFile(testFilePath, options)) {
        continue;
      }
      const testFile = await fetchSuiteFile(testFilePath);
      tests.push(...extractTestsFromFile(testFilePath, testFile.url, testFile.text));
    }
  }

  tests.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return tests;
}

function extractTestsFromFile(filePath: string, fileUrl: string, text: string): TestCase[] {
  let quads: Quad[];
  try {
    quads = parseSuiteRdf(text, fileUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse SHACL 1.2 test fixture ${filePath}: ${message}`, { cause: error });
  }
  const entries = subjects(quads, RDF_TYPE, SHT + 'Validate');
  const tests: TestCase[] = [];

  for (const entry of entries) {
    const action = object(quads, entry, MF + 'action');
    const result = object(quads, entry, MF + 'result');
    if (!action || !result) {
      continue;
    }

    const conforms = object(quads, result, SH + 'conforms');
    if (!conforms || conforms.termType !== 'Literal' || conforms.datatype.value !== XSD_BOOLEAN) {
      continue;
    }

    tests.push({
      id: termKey(entry),
      filePath,
      fileUrl,
      entry,
      quads,
      dataRefs: objects(quads, action, SHT + 'dataGraph'),
      shapesRefs: objects(quads, action, SHT + 'shapesGraph'),
      expectedConforms: conforms.value === 'true' || conforms.value === '1',
      conformanceDisallows: conformanceDisallows(quads, result),
    });
  }

  return tests;
}

function shouldRunTest(test: TestCase, options: CliOptions): boolean {
  if (options.only.size === 0) {
    return true;
  }
  return options.only.has(test.filePath) || options.only.has(fileName(test.filePath));
}

function shouldLoadTestFile(filePath: string, options: CliOptions): boolean {
  if (options.only.size === 0) {
    return true;
  }
  return options.only.has(filePath) || options.only.has(fileName(filePath));
}

async function loadDataAndShapes(test: TestCase): Promise<Quad[]> {
  const refs = uniqueTerms([...test.dataRefs, ...test.shapesRefs]);
  if (refs.length === 0 || refs.every((term) => term.termType === 'NamedNode' && term.value === test.fileUrl)) {
    return test.quads;
  }

  const quads: Quad[] = [];
  for (const ref of refs) {
    if (ref.termType !== 'NamedNode') {
      continue;
    }
    if (ref.value === test.fileUrl) {
      quads.push(...test.quads);
    } else {
      const file = await fetchAbsoluteSuiteUrl(ref.value);
      quads.push(...parseSuiteRdf(file.text, file.url));
    }
  }
  return uniqueQuads(quads);
}

function runValidation(rules: string, test: TestCase, dataAndShapes: Quad[]): TestOutcome {
  const closure = (reasonStream({ n3: rules, quads: dataAndShapes as RdfJsQuad[] }, {
    rdfjs: true,
    dataFactory: DataFactory,
    skipUnsupportedRdfJs: true,
  } as any).closureQuads ?? []) as Quad[];

  const resultSubjects = uniqueTerms(closure.filter((quad) => quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === SH + 'ValidationResult')
    .map((quad) => quad.subject as Term));

  const nonConformingResults = resultSubjects.filter((result) => {
    const severity = effectiveResultSeverity(closure, result);
    return test.conformanceDisallows.has(severity);
  });

  return {
    test,
    actualConforms: nonConformingResults.length === 0,
    resultCount: resultSubjects.length,
  };
}

function conformanceDisallows(quads: Quad[], report: Term): Set<string> {
  const values = objects(quads, report, SH + 'conformanceDisallows')
    .filter((term) => term.termType === 'NamedNode')
    .map((term) => term.value);
  return values.length > 0 ? new Set(values) : new Set(DEFAULT_CONFORMANCE_DISALLOWS);
}

function effectiveResultSeverity(quads: Quad[], result: Term): string {
  const sourceShape = object(quads, result, SH + 'sourceShape');
  const sourceSeverity = sourceShape ? object(quads, sourceShape, SH + 'severity') : undefined;
  if (sourceSeverity?.termType === 'NamedNode') {
    return sourceSeverity.value;
  }

  const resultSeverity = object(quads, result, SH + 'resultSeverity');
  if (resultSeverity?.termType === 'NamedNode') {
    return resultSeverity.value;
  }

  return SH + 'Violation';
}

function parseSuiteRdf(source: string, baseIRI: string): Quad[] {
  return parseRdfWithBase(rewriteRdf12Annotations(source), baseIRI);
}

function rewriteRdf12Annotations(source: string): string {
  if (!source.includes('{|')) {
    return source;
  }

  const lines = source.split(/\r?\n/);
  const rewritten: string[] = [];
  const extraTriples: string[] = [];
  let currentSubject = '';
  let reifierIndex = 0;

  if (!source.includes('@prefix shn:')) {
    rewritten.push('@prefix shn: <https://example.org/shacl-n3#> .');
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const subject = /^([A-Za-z][\w-]*:[^\s;]+|<[^>]+>|_:[^\s;]+)\s*$/.exec(line)?.[1];
    if (subject) {
      currentSubject = subject;
    }

    const inlineAnnotation = currentSubject
      ? /^(\s+)([A-Za-z][\w-]*:[^\s]+|<[^>]+>)\s+(.+?)\s+\{\|\s*(.*?)\s*\|\}(\s*[;,])\s*$/.exec(line)
      : undefined;
    if (inlineAnnotation) {
      const [, indent, predicate, object, annotation, separator] = inlineAnnotation;
      rewritten.push(`${indent}${predicate} ${normalizeBareBoolean(object)}${separator}`);
      if (predicate === 'sh:property' && /sh:deactivated\s+true/.test(annotation)) {
        extraTriples.push(`${normalizeBareBoolean(object)} sh:deactivated true .`);
      }
      continue;
    }

    const annotated = subject ? /^(\s+)([A-Za-z][\w-]*:[^\s]+|<[^>]+>)\s+(.+?)\s+\{\|\s*$/.exec(lines[index + 1] ?? '') : undefined;

    if (!subject || !annotated) {
      rewritten.push(line);
      continue;
    }

    const [, indent, predicate, object] = annotated;
    const annotations: string[] = [];
    index += 2;
    while (index < lines.length && !lines[index].includes('|}')) {
      const annotation = lines[index].trim();
      if (annotation) {
        annotations.push(normalizeBareBoolean(annotation.replace(/[.;]\s*$/, '')));
      }
      index += 1;
    }

    const reifier = `_:shacl12Reifier${reifierIndex}`;
    reifierIndex += 1;

    rewritten.push(line);
    const normalizedObject = normalizeBareBoolean(object);

    rewritten.push(`${indent}${predicate} ${normalizedObject} .`);
    rewritten.push(`${reifier} shn:reifiesSubject ${subject} ;`);
    rewritten.push(`  shn:reifiesPredicate ${predicate} ;`);
    rewritten.push(`  shn:reifiesObject ${normalizedObject}${annotations.length > 0 ? ' ;' : ' .'}`);

    for (let annotationIndex = 0; annotationIndex < annotations.length; annotationIndex += 1) {
      const suffix = annotationIndex === annotations.length - 1 ? ' .' : ' ;';
      rewritten.push(`  ${annotations[annotationIndex]}${suffix}`);
    }

    if ((lines[index + 1] ?? '').trim() === '.') {
      index += 1;
    }
  }

  return [...rewritten, ...extraTriples].join('\n');
}

function normalizeBareBoolean(term: string): string {
  return term.replace(/\b(true|false)\b/g, '"$1"^^xsd:boolean');
}

async function fetchSuiteFile(path: string): Promise<{ url: string; text: string }> {
  const suitePath = normalizeSuitePath(path);
  const url = RAW_BASE + suitePath;
  const cachePath = join(CACHE_ROOT, suitePath);
  return { url, text: await readCachedUrl(url, cachePath) };
}

async function fetchAbsoluteSuiteUrl(url: string): Promise<{ url: string; text: string }> {
  const path = suitePathFromUrl(url);
  const cachePath = join(CACHE_ROOT, path);
  return { url, text: await readCachedUrl(url, cachePath) };
}

function normalizeSuitePath(path: string): string {
  return path.replace(/^https:\/\/raw\.githubusercontent\.com\/w3c\/data-shapes\/gh-pages\/shacl12-test-suite\/tests\/core\//, '')
    .replace(/^shacl12-test-suite\/tests\/core\//, '')
    .replace(/^core\//, '')
    .replace(/^\/+/, '');
}

function suitePathFromUrl(url: string): string {
  const normalized = normalizeSuitePath(url);
  if (normalized !== url) {
    return normalized;
  }

  const parsed = new URL(url);
  const marker = '/shacl12-test-suite/tests/core/';
  const index = parsed.pathname.indexOf(marker);
  if (index >= 0) {
    return parsed.pathname.slice(index + marker.length);
  }

  const rawMarker = '/w3c/data-shapes/gh-pages/shacl12-test-suite/tests/core/';
  const rawIndex = parsed.pathname.indexOf(rawMarker);
  if (rawIndex >= 0) {
    return parsed.pathname.slice(rawIndex + rawMarker.length);
  }

  throw new Error(`Cannot map URL to SHACL 1.2 test-suite path: ${url}`);
}

function subjects(quads: Quad[], predicate: string, objectValue: string): Term[] {
  return uniqueTerms(quads
    .filter((quad) => quad.predicate.termType === 'NamedNode'
      && quad.predicate.value === predicate
      && quad.object.termType === 'NamedNode'
      && quad.object.value === objectValue)
    .map((quad) => quad.subject as Term));
}

function object(quads: Quad[], subject: Term, predicate: string): Term | undefined {
  return objects(quads, subject, predicate)[0];
}

function objects(quads: Quad[], subject: Term | undefined, predicate: string): Term[] {
  const values: Term[] = [];
  for (const quad of quads) {
    if (quad.predicate.termType !== 'NamedNode' || quad.predicate.value !== predicate) {
      continue;
    }
    if (subject && termKey(quad.subject as Term) !== termKey(subject)) {
      continue;
    }
    values.push(quad.object as Term);
  }
  return values;
}

function uniqueTerms(terms: Term[]): Term[] {
  const byKey = new Map<string, Term>();
  for (const term of terms) {
    byKey.set(termKey(term), term);
  }
  return Array.from(byKey.values());
}

function uniqueQuads(quads: Quad[]): Quad[] {
  const byKey = new Map<string, Quad>();
  for (const quad of quads) {
    byKey.set([quad.subject, quad.predicate, quad.object, quad.graph].map((term) => termKey(term as Term)).join(' '), quad);
  }
  return Array.from(byKey.values());
}

function fileName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1];
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
