import { readFileSync, writeFileSync } from 'node:fs';
import { Transform, type TransformCallback } from 'node:stream';
import type { DatasetCore, DataFactory, Quad, Term } from '@rdfjs/types';
import { DataFactory as RdfParserDataFactory } from 'rdf-parser-ts';
import { reasonStream, type RdfJsQuad } from 'eyeling';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

export type RuleProfile = string | { n3?: string; text?: string; label?: string; baseIri?: string };
export type VocabularyDataset = DatasetCore | Iterable<Quad>;

export interface LoadedRuleProfile {
  n3: string;
  label?: string;
  baseIri?: string;
}

export interface InferenceEngineOptions {
  runtime?: string;
  runtimePath?: string;
  dataFactory?: DataFactory;
  runtimeCompiler?: RuntimeCompiler;
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

export type RuntimeCompiler = (input: RuntimeCompilerInput) => string;

export interface SaveOptions {
  path: string;
}

export class InferenceEngine {
  private runtime = '';
  private readonly dataFactory: DataFactory;
  private readonly runtimeCompiler: RuntimeCompiler;

  public constructor(options: InferenceEngineOptions = {}) {
    this.dataFactory = options.dataFactory ?? (RdfParserDataFactory as unknown as DataFactory);
    this.runtimeCompiler = options.runtimeCompiler ?? defaultRuntimeCompiler;

    if (options.runtimePath) {
      this.runtime = readFileSync(options.runtimePath, 'utf8');
    } else if (options.runtime) {
      this.runtime = options.runtime;
    }
  }

  public getRuntime(): string {
    return this.runtime;
  }

  public load(profiles: RuleProfile | RuleProfile[], vocabulary: VocabularyDataset, options: LoadOptions = {}): string {
    const normalizedProfiles = normalizeProfiles(profiles);
    const profileN3 = normalizedProfiles.map((profile) => profile.n3).join('\n\n');
    const vocabularyQuads = quadsFromVocabulary(vocabulary);
    const closure = reasonStream({ n3: profileN3, quads: vocabularyQuads as RdfJsQuad[] }, {
      rdfjs: true,
      dataFactory: this.dataFactory as any,
    });

    const runtimeCompiler = options.runtimeCompiler ?? this.runtimeCompiler;
    this.runtime = runtimeCompiler({
      profiles: normalizedProfiles,
      profileN3,
      vocabulary: vocabularyQuads,
      closure: (closure.closureQuads ?? []) as Quad[],
      dataFactory: this.dataFactory,
      options,
    });

    return this.runtime;
  }

  public saveRuntime(pathOrOptions: string | SaveOptions): void {
    const path = typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions.path;
    writeFileSync(path, this.runtime, 'utf8');
  }

  public *infer(data: Quad[]): Generator<Quad> {
    this.assertLoaded();
    const derived: Quad[] = [];
    const seen = new Set<string>();

    reasonStream({ n3: this.runtime, quads: data as RdfJsQuad[] }, {
      rdfjs: true,
      dataFactory: this.dataFactory as any,
      onDerived: (item) => {
        if (item.quad) {
          addDerived(derived, seen, item.quad as Quad);
        }
        if (item.quads) {
          for (const quad of item.quads as Quad[]) {
            addDerived(derived, seen, quad);
          }
        }
      },
    });

    yield* derived;
  }

  public createInferenceStream(): Transform {
    return new Transform({
      objectMode: true,
      transform: (chunk: Iterable<Quad>, _encoding: BufferEncoding, callback: TransformCallback) => {
        try {
          const inferred = Array.from(this.infer(Array.from(chunk)));
          callback(null, inferred);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  public stream(): Transform {
    return this.createInferenceStream();
  }

  private assertLoaded(): void {
    if (!this.runtime.trim()) {
      throw new Error('No inference runtime is loaded. Call load(...) or pass runtime/runtimePath to the constructor first.');
    }
  }
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
      return literalToN3(term);
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
    : `b${Buffer.from(value).toString('hex')}`;
}

function addDerived(output: Quad[], seen: Set<string>, quad: Quad): void {
  const key = quadKey(quad);
  if (!seen.has(key)) {
    seen.add(key);
    output.push(quad);
  }
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
