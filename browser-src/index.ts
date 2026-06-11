import type { DatasetCore, DataFactory, Quad, Term } from '@rdfjs/types';
import eyeling from 'eyeling/browser';
import {
  DataFactory as RdfParserDataFactory,
  IncrementalParser,
  Parser,
  Writer,
  isMessageQuad,
  toMessages,
} from 'rdf-parser-ts/browser';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const OWLRL = 'https://example.org/owlrl-n3#';
const INTERNAL_HELPER_PREDICATES = new Set([
  OWLRL + 'listRoot',
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
]);

const reasonStream = (eyeling as any).reasonStream;

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
}

export interface LoadOptions {
  runtimeCompiler?: RuntimeCompiler;
  includeStaticClosure?: boolean;
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
type Listener = (...args: any[]) => void;

export class InferenceEngine {
  private runtime = '';
  private staticClosure: Quad[] = [];
  private readonly dataFactory: DataFactory;
  private readonly runtimeCompiler: RuntimeCompiler;
  private readonly outputMode: InferenceOutputMode;

  public constructor(options: InferenceEngineOptions = {}) {
    this.dataFactory = options.dataFactory ?? (RdfParserDataFactory as unknown as DataFactory);
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

  public load(profiles: RuleProfile | RuleProfile[], vocabulary: VocabularyDataset, options: LoadOptions = {}): string {
    const normalizedProfiles = normalizeProfiles(profiles);
    const profileN3 = normalizedProfiles.map((profile) => profile.n3).join('\n\n');
    const vocabularyQuads = quadsFromVocabulary(vocabulary);
    const closure = reasonStream({ n3: profileN3, quads: vocabularyQuads }, {
      rdfjs: true,
      dataFactory: this.dataFactory as any,
      skipUnsupportedRdfJs: true,
    });

    this.staticClosure = (closure.closureQuads ?? []) as Quad[];

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

    reasonStream({ n3: this.runtime, quads: data }, {
      rdfjs: true,
      dataFactory: this.dataFactory as any,
      skipUnsupportedRdfJs: true,
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

    yield* derived;
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
    const messages = toMessages(messageQuads as any[]).map((message: Iterable<Quad>) => Array.from(message));
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
    writer.end((error: Error | null, result?: string) => error ? reject(error) : resolve(result ?? ''));
  });
}

export async function writeMessages(messages: Iterable<Iterable<Quad>>, prefixes: Record<string, string> = {}): Promise<string> {
  const writer = new Writer({ prefixes, rdfMessages: true, format: 'N-Quads' });
  for (const message of messages) {
    writer.addMessage(message);
  }

  return new Promise<string>((resolve, reject) => {
    writer.end((error: Error | null, result?: string) => error ? reject(error) : resolve(result ?? ''));
  });
}

export function defaultRuntimeCompiler(input: RuntimeCompilerInput): string {
  const sections = ['# Generated inference runtime. Do not edit by hand.'];

  if (input.profileN3.trim()) {
    sections.push('', '# Rule profiles', input.profileN3.trimEnd());
  }

  if (input.options.includeStaticClosure !== false && input.closure.length > 0) {
    sections.push('', '# Precomputed background closure', serializeQuadsAsN3(input.closure).trimEnd());
  }

  return `${sections.join('\n')}\n`;
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

export {
  RdfParserDataFactory as DataFactory,
  IncrementalParser,
  Parser,
  Writer,
  isMessageQuad,
  toMessages,
};
