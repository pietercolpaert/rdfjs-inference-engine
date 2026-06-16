import type { DatasetCore, DataFactory, Quad, Term } from '@rdfjs/types';
import { rdfjs, reasonStream, runAsync, type EyelingTerm } from 'eyeling/browser';
import {
  DataFactory as RdfParserDataFactory,
  IncrementalParser,
  Parser,
  Writer,
  isMessageQuad,
  toMessages,
} from 'rdf-parser-ts/browser';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const LOG_SKOLEM = 'http://www.w3.org/2000/10/swap/log#skolem';
const SKOLEM_BASE_IRI = 'https://eyereasoner.github.io/.well-known/genid/';
const OWLRL = 'https://example.org/owlrl-n3#';
const OWLRL_INCONSISTENCY = OWLRL + 'Inconsistency';
const SHACL = 'http://www.w3.org/ns/shacl#';
const SHACL_VALIDATION_RESULT = SHACL + 'ValidationResult';
const SHACLN3 = 'https://example.org/shacl-n3#';
const INTERNAL_HELPER_PREDICATES = new Set([
  OWLRL + 'listRoot',
  OWLRL + 'intersectionListRoot',
  OWLRL + 'longIntersectionListRoot',
  OWLRL + 'keyListRoot',
  OWLRL + 'propertyChainRoot',
  OWLRL + 'listMember',
  OWLRL + 'listPair',
  OWLRL + 'left',
  OWLRL + 'right',
  OWLRL + 'allListClassTypes',
  OWLRL + 'sameValuesForProperties',
  OWLRL + 'propertyChainHolds',
  OWLRL + 'pathChain',
  OWLRL + 'pathSubject',
  OWLRL + 'pathObject',
  OWLRL + 'term',
  OWLRL + 'canonicalLiteral',
  OWLRL + 'rule',
  OWLRL + 'term1',
  OWLRL + 'term2',
  OWLRL + 'term3',
  OWLRL + 'term4',
  OWLRL + 'term5',
  SHACLN3 + 'active',
  SHACLN3 + 'focusFor',
  SHACLN3 + 'shape',
  SHACLN3 + 'focus',
  SHACLN3 + 'path',
  SHACLN3 + 'value',
]);

export type RuleProfile = string | { n3?: string; text?: string; label?: string; baseIri?: string };
export type VocabularyDataset = DatasetCore | Iterable<Quad>;

export interface LoadedRuleProfile {
  n3: string;
  label?: string;
  baseIri?: string;
}

export interface InferenceEngineOptions {
  runtime?: string;
  dataFactory?: DataFactory;
  runtimeCompiler?: RuntimeCompiler;
  outputMode?: InferenceOutputMode;
}

export type InferenceOutputMode = 'application' | 'conformance';

export interface InferenceOptions {
  outputMode?: InferenceOutputMode;
  store?: string | InferenceStoreOptions;
  storePath?: string;
  storeClear?: boolean;
  deterministicSkolem?: boolean;
  skolemKey?: string;
}

export interface InferenceStoreOptions {
  name: string;
  clear?: boolean;
  path?: string;
  type?: 'memory' | 'persistent';
  backend?: 'memory' | 'level' | 'indexeddb';
}

export interface LoadOptions {
  runtimeCompiler?: RuntimeCompiler;
  includeStaticClosure?: boolean;
  selectRuntimeRules?: boolean;
  deterministicSkolem?: boolean;
  skolemKey?: string;
}

export interface RuntimeCompilerInput {
  profiles: LoadedRuleProfile[];
  profileN3: string;
  vocabulary: Quad[];
  closure: Quad[];
  dataFactory: DataFactory;
  options: LoadOptions;
}

export interface ParsedRdfInput {
  isMessages: boolean;
  quads: Quad[];
  messages: Quad[][];
  raw: unknown[];
}

export type RuntimeCompiler = (input: RuntimeCompilerInput) => string;

export interface InconsistencyReport {
  id: string;
  rule?: string;
  terms: Term[];
  quads: Quad[];
}

export interface InferenceResult {
  quads: Quad[];
  inconsistencies: InconsistencyReport[];
}
type Listener = (...args: any[]) => void;

export class InferenceEngine {
  private runtime = '';
  private staticClosure: Quad[] = [];
  private readonly dataFactory: DataFactory;
  private readonly runtimeCompiler: RuntimeCompiler;
  private readonly outputMode: InferenceOutputMode;

  public constructor(options: InferenceEngineOptions = {}) {
    this.dataFactory = options.dataFactory ?? rdfjs;
    this.runtimeCompiler = options.runtimeCompiler ?? defaultRuntimeCompiler;
    this.outputMode = options.outputMode ?? 'application';

    if (options.runtime) {
      this.runtime = options.runtime;
    }
  }

  public getRuntime(): string {
    return this.runtime;
  }

  public getStaticClosure(options: InferenceOptions = {}): Quad[] {
    const outputMode = options.outputMode ?? this.outputMode;
    return this.staticClosure.filter((quad) => shouldEmitQuad(quad, outputMode));
  }

  public getStaticInconsistencies(options: InferenceOptions = {}): InconsistencyReport[] {
    const outputMode = options.outputMode ?? this.outputMode;
    return collectInconsistencyReports(this.staticClosure, outputMode);
  }

  public load(profiles: RuleProfile | RuleProfile[], vocabulary: VocabularyDataset, options: LoadOptions = {}): string {
    const normalizedProfiles = normalizeProfiles(profiles);
    const profileN3 = normalizedProfiles.map((profile) => profile.n3).join('\n\n');
    const vocabularyQuads = quadsFromVocabulary(vocabulary);
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);
    let closure: ReturnType<typeof reasonStream>;
    try {
      closure = reasonStream({ n3: profileN3, quads: vocabularyQuads }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    this.staticClosure = closure.closureQuads ?? [];

    const runtimeCompiler = options.runtimeCompiler ?? this.runtimeCompiler;
    this.runtime = runtimeCompiler({
      profiles: normalizedProfiles,
      profileN3,
      vocabulary: vocabularyQuads,
      closure: this.staticClosure,
      dataFactory: this.dataFactory,
      options,
    });

    return this.runtime;
  }

  public *infer(data: Quad[], options: InferenceOptions = {}): Generator<Quad> {
    this.assertLoaded();
    const derived: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);

    try {
      reasonStream({ n3: this.runtime, quads: data }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    yield* derived;
  }

  public inferWithDiagnostics(data: Quad[], options: InferenceOptions = {}): InferenceResult {
    this.assertLoaded();
    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);

    try {
      reasonStream({ n3: this.runtime, quads: data }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            diagnostics.push(item.quad);
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              diagnostics.push(quad);
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    return {
      quads: derived,
      inconsistencies: collectInconsistencyReports([...this.staticClosure, ...diagnostics], outputMode),
    };
  }

  public async inferAsync(data: Quad[], options: InferenceOptions = {}): Promise<Quad[]> {
    this.assertLoaded();
    if (!options.store && !options.storePath && !options.storeClear) {
      return Array.from(this.infer(data, options));
    }

    const derived: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);
    let result: Awaited<ReturnType<typeof runAsync>>;
    try {
      result = await runAsync({ n3: this.runtime, quads: data }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        store: options.store,
        storePath: options.storePath,
        storeClear: options.storeClear,
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    if (result.store && typeof result.store.close === 'function') {
      await result.store.close();
    }

    return derived;
  }

  public async inferAsyncWithDiagnostics(data: Quad[], options: InferenceOptions = {}): Promise<InferenceResult> {
    this.assertLoaded();
    if (!options.store && !options.storePath && !options.storeClear) {
      return this.inferWithDiagnostics(data, options);
    }

    const derived: Quad[] = [];
    const diagnostics: Quad[] = [];
    const seen = new Set<string>();
    const outputMode = options.outputMode ?? this.outputMode;
    const deterministicSkolem = createDeterministicSkolemBuiltin(options);
    let result: Awaited<ReturnType<typeof runAsync>>;
    try {
      result = await runAsync({ n3: this.runtime, quads: data }, {
        rdfjs: true,
        dataFactory: this.dataFactory,
        skipUnsupportedRdfJs: true,
        builtinModules: deterministicSkolemBuiltinModules(deterministicSkolem),
        store: options.store,
        storePath: options.storePath,
        storeClear: options.storeClear,
        onDerived: (item: { quad?: Quad; quads?: Quad[] }) => {
          if (item.quad) {
            diagnostics.push(item.quad);
            addDerived(derived, seen, item.quad, outputMode);
          }
          if (item.quads) {
            for (const quad of item.quads) {
              diagnostics.push(quad);
              addDerived(derived, seen, quad, outputMode);
            }
          }
        },
      });
    } finally {
      unregisterDeterministicSkolemBuiltin(deterministicSkolem);
    }

    if (result.store && typeof result.store.close === 'function') {
      await result.store.close();
    }

    return {
      quads: derived,
      inconsistencies: collectInconsistencyReports([...this.staticClosure, ...diagnostics], outputMode),
    };
  }

  public createInferenceStream(): BrowserInferenceStream {
    return new BrowserInferenceStream((chunk) => Array.from(this.infer(Array.from(chunk))));
  }

  public stream(): BrowserInferenceStream {
    return this.createInferenceStream();
  }

  private assertLoaded(): void {
    if (!this.runtime.trim()) {
      throw new Error('No inference runtime is loaded. Call load(...) or pass runtime to the constructor first.');
    }
  }
}

export class BrowserInferenceStream {
  private readonly listeners: Record<string, Listener[]> = Object.create(null);

  public constructor(private readonly transformChunk: (chunk: Iterable<Quad>) => Quad[]) {}

  public write(chunk: Iterable<Quad>): boolean {
    try {
      this.emit('data', this.transformChunk(chunk));
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  public end(chunk?: Iterable<Quad>): void {
    if (chunk) {
      this.write(chunk);
    }
    this.emit('end');
  }

  public on(event: 'data' | 'error' | 'end', listener: Listener): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  public addEventListener(event: 'data' | 'error' | 'end', listener: Listener): this {
    return this.on(event, listener);
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners[event] ?? []) {
      listener(...args);
    }
  }
}

export function parseRdfOrMessages(source: string, options: Record<string, unknown> = {}): ParsedRdfInput {
  const parsed = parseWithAutomaticMessages(source, options);
  const raw = Array.from(parsed as Iterable<unknown>);
  const messageQuads = raw.filter((item) => isMessageQuad(item));

  if (messageQuads.length > 0) {
    const messages = toMessages(messageQuads as any[]).map((message) => Array.from(message as Iterable<Quad>));
    return {
      isMessages: true,
      quads: messageQuads.map((item: any) => item.quad as Quad),
      messages,
      raw,
    };
  }

  return {
    isMessages: false,
    quads: raw as Quad[],
    messages: [],
    raw,
  };
}

export async function writeQuads(quads: Iterable<Quad>, prefixes: Record<string, string> = {}): Promise<string> {
  const writer = new Writer({ prefixes });
  writer.addQuads(quads);

  return new Promise<string>((resolve, reject) => {
    writer.end((error?: Error | null, result?: string) => error ? reject(error) : resolve(result ?? ''));
  });
}

export async function writeMessages(messages: Iterable<Iterable<Quad>>, prefixes: Record<string, string> = {}): Promise<string> {
  const writer = new Writer({ prefixes, rdfMessages: true, format: 'N-Quads' });
  for (const message of messages) {
    writer.addMessage(message);
  }

  return new Promise<string>((resolve, reject) => {
    writer.end((error?: Error | null, result?: string) => error ? reject(error) : resolve(result ?? ''));
  });
}

export function defaultRuntimeCompiler(input: RuntimeCompilerInput): string {
  const sections = ['# Generated inference runtime. Do not edit by hand.'];
  const runtimeProfileN3 = input.options.selectRuntimeRules === false
    ? input.profileN3.trimEnd()
    : compileSelectedRuntimeProfiles(input).trimEnd();

  if (runtimeProfileN3.trim()) {
    sections.push('', '# Runtime rule profile', runtimeProfileN3);
  }

  if (input.options.includeStaticClosure !== false) {
    const backgroundClosure = uniqueQuads([...input.vocabulary, ...input.closure]);
    if (backgroundClosure.length > 0) {
      sections.push('', '# Precomputed background facts and closure', serializeQuadsAsN3(backgroundClosure).trimEnd());
    }
  }

  return `${sections.join('\n')}\n`;
}

interface RuntimeRuleSelectionContext {
  staticPredicates: Set<string>;
  staticPredicateObjects: Set<string>;
  staticTerms: Set<string>;
  inputTerms: Set<string>;
}

const KNOWN_PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sh: 'http://www.w3.org/ns/shacl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  shn: SHACLN3,
  owlrl: OWLRL,
};

const STATIC_SCHEMA_PREDICATES = [
  'rdfs:domain',
  'rdfs:range',
  'rdfs:subClassOf',
  'rdfs:subPropertyOf',
  'owl:equivalentClass',
  'owl:equivalentProperty',
  'owl:inverseOf',
  'owl:propertyChainAxiom',
  'owl:intersectionOf',
  'owl:unionOf',
  'owl:oneOf',
  'owl:members',
  'owl:distinctMembers',
  'owl:hasKey',
  'owl:onProperty',
  'owl:onClass',
  'owl:onDataRange',
  'owl:someValuesFrom',
  'owl:allValuesFrom',
  'owl:hasValue',
  'owl:maxCardinality',
  'owl:maxQualifiedCardinality',
  'owl:complementOf',
  'owl:disjointWith',
  'owl:disjointUnionOf',
  'owl:datatypeComplementOf',
  'sh:path',
  'sh:property',
  'sh:targetNode',
  'sh:targetClass',
  'sh:targetSubjectsOf',
  'sh:targetObjectsOf',
  'sh:class',
  'sh:datatype',
  'sh:minCount',
  'sh:maxCount',
  'sh:hasValue',
  'sh:in',
  'sh:minInclusive',
  'sh:minExclusive',
  'sh:maxInclusive',
  'sh:maxExclusive',
  'sh:minLength',
  'sh:maxLength',
  'sh:pattern',
  'sh:node',
  'sh:and',
  'sh:or',
  'sh:not',
  'sh:xone',
  'sh:qualifiedValueShape',
  'sh:qualifiedMinCount',
  'sh:qualifiedMaxCount',
];

const STATIC_TYPE_GUARDS = [
  'owl:FunctionalProperty',
  'owl:InverseFunctionalProperty',
  'owl:TransitiveProperty',
  'owl:SymmetricProperty',
  'owl:AsymmetricProperty',
  'owl:IrreflexiveProperty',
  'owl:AnnotationProperty',
  'owl:AllDifferent',
  'owl:AllDisjointClasses',
  'owl:AllDisjointProperties',
  'owl:Class',
  'rdfs:Class',
  'rdfs:Datatype',
  'sh:NodeShape',
  'sh:PropertyShape',
];

function compileSelectedRuntimeProfiles(input: RuntimeCompilerInput): string {
  const context = runtimeRuleSelectionContext(input.vocabulary, [...input.vocabulary, ...input.closure]);
  const sections: string[] = [];
  let selectedRules = 0;
  let totalRules = 0;

  for (const profile of input.profiles) {
    const source = profile.n3.trimEnd();
    if (!source) {
      continue;
    }

    if (!isRuntimeProfileRelevant(profile, context)) {
      continue;
    }

    const prefixes = extractPrefixDeclarations(source);
    const rules = extractTopLevelRuleStatements(source);
    totalRules += rules.length;
    const relevantRules = rules.filter((rule) => isRuntimeRuleRelevant(rule, context));
    selectedRules += relevantRules.length;

    if (relevantRules.length === 0) {
      continue;
    }

    if (profile.label) {
      sections.push(`# Source: ${profile.label}`);
    }
    sections.push(...prefixes, '', ...relevantRules);
  }

  if (sections.length === 0) {
    return '';
  }

  return [
    `# Selected ${selectedRules}/${totalRules} top-level runtime rules for the load-time vocabulary.`,
    ...sections,
  ].join('\n');
}

function runtimeRuleSelectionContext(inputQuads: Iterable<Quad>, staticQuads: Iterable<Quad>): RuntimeRuleSelectionContext {
  const staticPredicates = new Set<string>();
  const staticPredicateObjects = new Set<string>();
  const staticTerms = new Set<string>();
  const inputTerms = new Set<string>();

  for (const quad of inputQuads) {
    addTermValue(inputTerms, quad.subject);
    addTermValue(inputTerms, quad.predicate);
    addTermValue(inputTerms, quad.object);
  }

  for (const quad of staticQuads) {
    addTermValue(staticTerms, quad.subject);
    addTermValue(staticTerms, quad.predicate);
    addTermValue(staticTerms, quad.object);
    if (quad.predicate.termType === 'NamedNode') {
      staticPredicates.add(quad.predicate.value);
      if (quad.object.termType === 'NamedNode') {
        staticPredicateObjects.add(`${quad.predicate.value}\t${quad.object.value}`);
      }
    }
  }

  return { staticPredicates, staticPredicateObjects, staticTerms, inputTerms };
}

function addTermValue(values: Set<string>, term: Term): void {
  if (term.termType === 'NamedNode') {
    values.add(term.value);
  }
}

function isRuntimeProfileRelevant(profile: LoadedRuleProfile, context: RuntimeRuleSelectionContext): boolean {
  const label = (profile.label ?? '').toLowerCase();
  const source = profile.n3;
  const hasShaclProfile = label.includes('shacl') || source.includes('@prefix sh:');
  const hasSkosProfile = label.includes('skos') || source.includes('@prefix skos:');
  const hasOwlProfile = label.includes('owl') || source.includes('@prefix owlrl:');

  if (hasShaclProfile && !hasSkosProfile && !hasOwlProfile) {
    return hasNamespaceTerm(context, 'http://www.w3.org/ns/shacl#');
  }
  if (hasSkosProfile && !hasShaclProfile && !hasOwlProfile) {
    return hasNamespaceTerm(context, 'http://www.w3.org/2004/02/skos/core#');
  }
  return true;
}

function hasNamespaceTerm(context: RuntimeRuleSelectionContext, namespace: string): boolean {
  for (const term of context.inputTerms) {
    if (term.startsWith(namespace)) {
      return true;
    }
  }
  return false;
}

function isRuntimeRuleRelevant(rule: string, context: RuntimeRuleSelectionContext): boolean {
  const body = runtimeRuleBody(rule);

  for (const qname of STATIC_SCHEMA_PREDICATES) {
    if (!qnameAppearsAsPredicate(body, qname)) {
      continue;
    }
    const iriValue = qnameToIri(qname);
    if (iriValue && !context.staticPredicates.has(iriValue)) {
      return false;
    }
  }

  for (const qname of STATIC_TYPE_GUARDS) {
    if (!qnameAppearsAsTypeObject(body, qname)) {
      continue;
    }
    const iriValue = qnameToIri(qname);
    if (iriValue && !context.staticPredicateObjects.has(`${RDF_TYPE}\t${iriValue}`)) {
      return false;
    }
  }

  return true;
}

function runtimeRuleBody(rule: string): string {
  const forwardIndex = rule.indexOf('=>');
  const backwardIndex = rule.indexOf('<=');
  if (forwardIndex >= 0 && (backwardIndex < 0 || forwardIndex < backwardIndex)) {
    return rule.slice(0, forwardIndex);
  }
  if (backwardIndex >= 0) {
    return rule.slice(backwardIndex + 2);
  }
  return rule;
}

function qnameAppearsAsPredicate(source: string, qname: string): boolean {
  return new RegExp(`(^|[\\s;])${escapeRegExp(qname)}(?=\\s)`).test(source);
}

function qnameAppearsAsTypeObject(source: string, qname: string): boolean {
  return new RegExp(`(^|[\\s;])(?:rdf:type|a)\\s+${escapeRegExp(qname)}(?=[\\s.;])`).test(source);
}

function qnameToIri(qname: string): string | undefined {
  const [prefix, local] = qname.split(':', 2);
  const namespace = KNOWN_PREFIXES[prefix];
  return namespace ? namespace + local : undefined;
}

function extractPrefixDeclarations(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^@(prefix|base)\b/i.test(line));
}

function extractTopLevelRuleStatements(source: string): string[] {
  const rules: string[] = [];
  let ruleStart = -1;
  let braceDepth = 0;
  let stringQuote = '';
  let tripleQuoted = false;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inComment) {
      if (char === '\n' || char === '\r') {
        inComment = false;
      }
      continue;
    }

    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (tripleQuoted && source.startsWith(stringQuote.repeat(3), index)) {
        index += 2;
        stringQuote = '';
        tripleQuoted = false;
      } else if (!tripleQuoted && char === stringQuote) {
        stringQuote = '';
      }
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      tripleQuoted = source.startsWith(char.repeat(3), index);
      if (tripleQuoted) {
        index += 2;
      }
      continue;
    }

    if (char === '{') {
      if (braceDepth === 0 && ruleStart < 0) {
        ruleStart = index;
      }
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === '.' && braceDepth === 0 && ruleStart >= 0) {
      const statement = source.slice(ruleStart, index + 1).trim();
      if (statement.includes('=>') || statement.includes('<=')) {
        rules.push(statement);
      }
      ruleStart = -1;
    }
  }

  return rules;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueQuads(quads: Iterable<Quad>): Quad[] {
  const unique: Quad[] = [];
  const seen = new Set<string>();

  for (const quad of quads) {
    const key = quadKey(quad);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(quad);
    }
  }

  return unique;
}

export function serializeQuadsAsN3(quads: Iterable<Quad>): string {
  return Array.from(quads, quadToN3).join('\n');
}

function parseWithAutomaticMessages(source: string, options: Record<string, unknown>): Iterable<unknown> {
  try {
    return new Parser({ factory: RdfParserDataFactory, ...options }).parse(source) ?? [];
  } catch (error) {
    if (!hasMessageSyntax(source)) {
      throw error;
    }
    return new Parser({ factory: RdfParserDataFactory, ...options, rdfMessages: true }).parse(source) ?? [];
  }
}

function hasMessageSyntax(source: string): boolean {
  return /(?:@version\s+["']1\.2-messages["']|VERSION\s+["']1\.2-messages["']|@message\b|^\s*MESSAGE\b)/im.test(source);
}

function normalizeProfiles(profiles: RuleProfile | RuleProfile[]): LoadedRuleProfile[] {
  return (Array.isArray(profiles) ? profiles : [profiles]).map((profile) => {
    if (typeof profile === 'string') {
      return { n3: profile };
    }

    return {
      n3: profile.n3 ?? profile.text ?? '',
      label: profile.label,
      baseIri: profile.baseIri,
    };
  });
}

function quadsFromVocabulary(vocabulary: VocabularyDataset): Quad[] {
  if (Symbol.iterator in Object(vocabulary)) {
    return Array.from(vocabulary as Iterable<Quad>);
  }

  const quads: Quad[] = [];
  const dataset = vocabulary as DatasetCore & { forEach?: (callback: (quad: Quad) => void) => void };
  if (typeof dataset.forEach === 'function') {
    dataset.forEach((quad) => quads.push(quad));
    return quads;
  }

  throw new TypeError('The vocabulary dataset must be iterable or implement DatasetCore.forEach.');
}

function quadToN3(quad: Quad): string {
  const statement = `${termToN3(quad.subject)} ${termToN3(quad.predicate)} ${termToN3(quad.object)} .`;
  if (quad.graph.termType === 'DefaultGraph') {
    return statement;
  }

  return `${termToN3(quad.graph)} { ${statement} }`;
}

function termToN3(term: Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return iri(term.value);
    case 'BlankNode':
      return `_:${blankNodeLabel(term.value)}`;
    case 'Literal':
      return literalToN3(term as Extract<Term, { termType: 'Literal' }>);
    case 'DefaultGraph':
      return '';
    default:
      throw new TypeError(`Unsupported RDF-JS term type in runtime serialization: ${term.termType}`);
  }
}

function literalToN3(term: Extract<Term, { termType: 'Literal' }>): string {
  const value = JSON.stringify(term.value);
  if (term.language) {
    return `${value}@${term.language}`;
  }
  if (term.datatype.value !== XSD_STRING) {
    return `${value}^^${iri(term.datatype.value)}`;
  }
  return value;
}

function iri(value: string): string {
  return `<${value.replace(/>/g, '%3E')}>`;
}

function blankNodeLabel(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
    ? value
    : `b${Array.from(value).map((character) => character.codePointAt(0)?.toString(16).padStart(2, '0') ?? '').join('')}`;
}

function addDerived(output: Quad[], seen: Set<string>, quad: Quad, outputMode: InferenceOutputMode): void {
  if (!shouldEmitQuad(quad, outputMode)) {
    return;
  }

  const key = quadKey(quad);
  if (!seen.has(key)) {
    seen.add(key);
    output.push(quad);
  }
}

function shouldEmitQuad(quad: Quad, outputMode: InferenceOutputMode): boolean {
  if (isInternalHelperQuad(quad)) {
    return false;
  }
  if (isReflexiveSameAs(quad)) {
    return false;
  }
  if (outputMode !== 'conformance' && hasGeneratedSkolemTerm(quad) && !isShaclValidationResultQuad(quad)) {
    return false;
  }
  if (outputMode !== 'conformance' && isAnonymousClassType(quad)) {
    return false;
  }

  return outputMode === 'conformance'
    || !hasLiteralSubject(quad);
}

function isReflexiveSameAs(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === OWL_SAME_AS
    && termEquals(quad.subject, quad.object);
}

function isInternalHelperQuad(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && INTERNAL_HELPER_PREDICATES.has(quad.predicate.value);
}

function isShaclValidationResultQuad(quad: Quad): boolean {
  if (quad.predicate.termType !== 'NamedNode') {
    return false;
  }

  return (quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === SHACL_VALIDATION_RESULT)
    || quad.predicate.value.startsWith(SHACL);
}

function hasGeneratedSkolemTerm(quad: Quad): boolean {
  return [quad.subject, quad.predicate, quad.object, quad.graph].some(isGeneratedSkolemTerm);
}

function isGeneratedSkolemTerm(term: Term): boolean {
  return term.termType === 'NamedNode'
    && term.value.startsWith(SKOLEM_BASE_IRI);
}

function isAnonymousClassType(quad: Quad): boolean {
  return quad.predicate.termType === 'NamedNode'
    && quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'BlankNode';
}

function collectInconsistencyReports(quads: Iterable<Quad>, outputMode: InferenceOutputMode): InconsistencyReport[] {
  const byId = new Map<string, { quads: Quad[]; rule?: string; terms: Map<number, Term> }>();

  for (const quad of quads) {
    if (!isInconsistencyDiagnosticQuad(quad)) {
      continue;
    }

    const id = termKey(quad.subject as Term);
    const report = byId.get(id) ?? { quads: [], terms: new Map<number, Term>() };
    report.quads.push(quad);

    if (quad.predicate.value === OWLRL + 'rule') {
      report.rule = quad.object.value;
    } else if (quad.predicate.value.startsWith(OWLRL + 'term')) {
      const index = Number.parseInt(quad.predicate.value.slice((OWLRL + 'term').length), 10);
      if (Number.isInteger(index)) {
        report.terms.set(index, quad.object as Term);
      }
    }

    byId.set(id, report);
  }

  return Array.from(byId.entries())
    .map(([id, report]) => ({
      id,
      rule: report.rule,
      terms: Array.from(report.terms.entries())
        .sort(([left], [right]) => left - right)
        .map(([, term]) => term),
      quads: report.quads,
    }))
    .filter((report) => outputMode === 'conformance'
      || !report.terms.some(isGeneratedSkolemTerm));
}

function isInconsistencyDiagnosticQuad(quad: Quad): boolean {
  if (quad.predicate.termType !== 'NamedNode') {
    return false;
  }

  return (quad.predicate.value === RDF_TYPE
    && quad.object.termType === 'NamedNode'
    && quad.object.value === OWLRL_INCONSISTENCY)
    || quad.predicate.value === OWLRL + 'rule'
    || /^https:\/\/example\.org\/owlrl-n3#term[1-5]$/.test(quad.predicate.value);
}

function hasLiteralSubject(quad: Quad): boolean {
  return (quad.subject as unknown as Term).termType === 'Literal';
}

function termEquals(left: Term, right: Term): boolean {
  if (left.termType !== right.termType || left.value !== right.value) {
    return false;
  }
  if (left.termType === 'Literal' && right.termType === 'Literal') {
    return left.language === right.language && left.datatype.value === right.datatype.value;
  }
  return true;
}

function quadKey(quad: Quad): string {
  return [quad.subject, quad.predicate, quad.object, quad.graph].map(termKey).join(' ');
}

function termKey(term: Term): string {
  if (term.termType === 'Literal') {
    return `"${term.value}"@${term.language}^^${term.datatype.value}`;
  }
  return `${term.termType}:${term.value}`;
}

type DeterministicSkolemOptions = Pick<InferenceOptions, 'deterministicSkolem' | 'skolemKey' | 'store' | 'storePath' | 'storeClear'>;
type BuiltinHandler = (context: { goal: { s: unknown; o: unknown }; subst: Record<string, EyelingTerm> }) => Array<Record<string, EyelingTerm>>;
type BuiltinModule = (api: DeterministicSkolemApi) => void;
type BuiltinModuleOption = string[];
interface DeterministicSkolemBuiltin {
  module: BuiltinModule;
  unregister?: (iri: string) => boolean;
}

interface DeterministicSkolemApi {
  registerBuiltin(iri: string, handler: BuiltinHandler): BuiltinHandler;
  unregisterBuiltin(iri: string): boolean;
  internIri(value: string): EyelingTerm;
  unifyTerm(left: unknown, right: unknown, subst: Record<string, EyelingTerm>): Record<string, EyelingTerm> | null;
  isGroundTerm(term: unknown): boolean;
  termToN3(term: unknown): string;
  terms?: {
    Var?: new (...args: never[]) => { name: string };
  };
}

function createDeterministicSkolemBuiltin(options: DeterministicSkolemOptions): DeterministicSkolemBuiltin | undefined {
  if (!shouldUseDeterministicSkolem(options)) {
    return undefined;
  }

  const scopeKey = deterministicSkolemScopeKey(options);
  const deterministicSkolem: DeterministicSkolemBuiltin = {
    module: (api) => {
      const { registerBuiltin, unregisterBuiltin, internIri, unifyTerm, isGroundTerm, termToN3, terms } = api;
      const Var = terms?.Var;
      deterministicSkolem.unregister = unregisterBuiltin;
      registerBuiltin(LOG_SKOLEM, ({ goal, subst }) => {
        if (!isGroundTerm(goal.s)) {
          return [];
        }

        const tupleKey = `${scopeKey}\0${termToN3(goal.s)}`;
        const node = internIri(SKOLEM_BASE_IRI + deterministicSkolemIdFromKey(tupleKey));
        if (Var && goal.o instanceof Var) {
          return [{ ...subst, [goal.o.name]: node }];
        }

        const next = unifyTerm(goal.o, node, subst);
        return next !== null ? [next] : [];
      });
    },
  };
  return deterministicSkolem;
}

function unregisterDeterministicSkolemBuiltin(deterministicSkolem: DeterministicSkolemBuiltin | undefined): void {
  deterministicSkolem?.unregister?.(LOG_SKOLEM);
}

function deterministicSkolemBuiltinModules(deterministicSkolem: DeterministicSkolemBuiltin | undefined): BuiltinModuleOption | undefined {
  return deterministicSkolem
    ? [deterministicSkolem.module] as unknown as BuiltinModuleOption
    : undefined;
}

function shouldUseDeterministicSkolem(options: DeterministicSkolemOptions): boolean {
  return options.deterministicSkolem
    ?? Boolean(options.skolemKey || options.store || options.storePath || options.storeClear);
}

function deterministicSkolemScopeKey(options: DeterministicSkolemOptions): string {
  if (options.skolemKey) {
    return `key:${options.skolemKey}`;
  }

  const store = options.store;
  if (typeof store === 'string') {
    return `store:${store}\0path:${options.storePath ?? ''}`;
  }
  if (store && typeof store === 'object') {
    return [
      'store',
      store.name,
      store.path ?? options.storePath ?? '',
      store.type ?? '',
      store.backend ?? '',
    ].join('\0');
  }

  return `storePath:${options.storePath ?? ''}`;
}

function deterministicSkolemIdFromKey(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  let h3 = 0x811c9dc5;
  let h4 = 0x811c9dc5;

  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + 1;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    h3 ^= code + 2;
    h3 = Math.imul(h3, 0x01000193) >>> 0;
    h4 ^= code + 3;
    h4 = Math.imul(h4, 0x01000193) >>> 0;
  }

  const hex = [h1, h2, h3, h4]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export {
  RdfParserDataFactory as DataFactory,
  IncrementalParser,
  Parser,
  Writer,
  isMessageQuad,
  toMessages,
};
