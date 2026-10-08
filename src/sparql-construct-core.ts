import type { Quad, Term } from '@rdfjs/types';
import type { RuleProfile } from './InferenceEngine';
import { compileOutputProjection, type SparqlConstructMapping } from './sparql-output-projection';
import { translateN3RuntimeToSparql, type N3SparqlDiagnostic, type SparqlRuntimeProgram } from './n3-to-sparql';
const { Writer, DataFactory } = require('n3');
export type { SparqlConstructMapping } from './sparql-output-projection';
export interface SparqlConstructInput {
  ontology: Iterable<Quad>;
  shaclIn: Iterable<Quad>;
  shaclOut: Iterable<Quad>;
  /** Override the bundled profiles with an explicit N3 source/runtime. */
  rules?: string;
  /** Defaults to the engine's bundled OWL 2 RL, SKOS and prepared QUDT profiles. */
  profiles?: RuleProfile[];
}
export interface SparqlConstructDiagnostic extends N3SparqlDiagnostic { shape?: string; path?: string }
export interface SparqlConstructResult {
  /** Final consumer projection, executed after inference. */
  query: string | null;
  program: SparqlRuntimeProgram | null;
  /** Exact engine-generated N3 runtime translated into SPARQL. */
  runtime: string;
  mappings: SparqlConstructMapping[];
  diagnostics: SparqlConstructDiagnostic[];
}
type RuntimeBuilder = (profiles: RuleProfile[], ontology: Quad[], provider: Quad[], consumer: Quad[]) => { runtime: string; diagnostics: SparqlConstructDiagnostic[] };
/** Eyeling also tracks generalized RDF datatype facts with literal subjects.
 * Keep the original rules, but serialize RDF/JS-compatible background facts.
 */
export function withRdfBackground<T extends { closure: Quad[] }>(compile: (input: T) => string, excluded: (count: number) => void): (input: T) => string {
  return input => {
    const closure = input.closure.filter(q => (q.subject as Term).termType !== 'Literal');
    excluded(input.closure.length - closure.length);
    return compile({ ...input, closure });
  };
}
/** Share projection and translation between the Node and browser engine adapters. */
export function createSparqlConstructGenerator(buildRuntime: RuntimeBuilder, defaults: () => RuleProfile[]) {
  return (input: SparqlConstructInput): SparqlConstructResult => {
    const ontology = Array.from(input.ontology), provider = Array.from(input.shaclIn), consumer = Array.from(input.shaclOut);
    const projection = compileOutputProjection({ shaclOut: consumer });
    const diagnostics: SparqlConstructDiagnostic[] = [...projection.diagnostics];
    if (!provider.length) diagnostics.push({ severity: 'error', message: 'Provider SHACL input is empty.' });
    if (input.rules !== undefined && input.profiles !== undefined) diagnostics.push({ severity: 'error', message: 'Specify either an N3 runtime or rule profiles, not both.' });
    let runtime = '', program: SparqlRuntimeProgram | null = null;
    if (!diagnostics.some(d => d.severity === 'error')) {
      try {
        if (input.rules === undefined) {
          const prepared = buildRuntime(input.profiles ?? defaults(), ontology, provider, consumer);
          runtime = prepared.runtime;
          diagnostics.push(...prepared.diagnostics);
        } else runtime = `${input.rules}\n# Provider ontology\n${serialize(ontology, 'ontology_')}\n# Consumer output contract\n${serialize(consumer, 'consumer_')}`;
        const translated = translateN3RuntimeToSparql(runtime);
        diagnostics.push(...translated.diagnostics);
        program = translated.program;
        // Bundled profiles infer additional facts; input facts remain available
        // for identity fields selected by the consumer contract.
        if (program && input.rules === undefined) program.projectionSource = 'closure';
      } catch (error) {
        diagnostics.push({ severity: 'error', message: `Could not prepare the inference runtime: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const failed = diagnostics.some(d => d.severity === 'error');
    return { query: failed ? null : projection.query, program: failed ? null : program, runtime, mappings: projection.mappings, diagnostics };
  };
}
function serialize(quads: Quad[], prefix: string): string {
  const blank = (t: Term) => t.termType === 'BlankNode' ? DataFactory.blankNode(prefix + t.value) : t;
  return new Writer({ format: 'N3' }).quadsToString(quads.map(q => DataFactory.quad(blank(q.subject), q.predicate, blank(q.object), q.graph)));
}
