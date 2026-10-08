import type { Quad, Term } from '@rdfjs/types';
import { compileOutputProjection, type SparqlConstructMapping } from './sparql-output-projection';
import { translateN3RuntimeToSparql, type N3SparqlDiagnostic, type SparqlRuntimeProgram } from './n3-to-sparql';
import { defaultSparqlMappingRules } from './sparql-rule-profile';
import { compileShaclShapeGraph } from './shacl-shape-planning';
const { Writer, DataFactory } = require('n3');
export type { SparqlConstructMapping } from './sparql-output-projection';
export interface SparqlConstructInput {
  ontology: Iterable<Quad>;
  shaclIn: Iterable<Quad>;
  shaclOut: Iterable<Quad>;
  /** N3 rule source or InferenceEngine.getRuntime(). Defaults to the editable mapping profile. */
  rules?: string;
}
export interface SparqlConstructDiagnostic extends N3SparqlDiagnostic { shape?: string; path?: string }
export interface SparqlConstructResult {
  /** Final projection: execute on runtime-derived facts, not raw input. */
  query: string | null;
  program: SparqlRuntimeProgram | null;
  /** Exact N3 source translated, including static vocabulary and output shape facts. */
  runtime: string;
  mappings: SparqlConstructMapping[];
  diagnostics: SparqlConstructDiagnostic[];
}
/** Translate N3 inference rules, then project the consumer's requested fields.
 * Provider SHACL documents the input contract; it does not invent inference rules.
 */
export function generateSparqlConstruct(input: SparqlConstructInput): SparqlConstructResult {
  const ontology = Array.from(input.ontology), provider = Array.from(input.shaclIn), consumer = Array.from(input.shaclOut);
  const projection = compileOutputProjection({ shaclOut: consumer });
  const serialize = (quads: Quad[], prefix: string) => {
    const blank = (t: Term) => t.termType === 'BlankNode' ? DataFactory.blankNode(prefix + t.value) : t;
    return new Writer({ format: 'N3' }).quadsToString(quads.map(q => DataFactory.quad(blank(q.subject), q.predicate, blank(q.object), q.graph)));
  };
  // Independent documents have independent blank-node scopes. Provider shapes remain
  // documentation, so their sh:unit declarations cannot become output configuration.
  const runtime = `${input.rules ?? defaultSparqlMappingRules}\n# Provider ontology\n${serialize(ontology, 'ontology_')}\n# Consumer output contract\n${serialize(consumer, 'consumer_')}`;
  const translated = translateN3RuntimeToSparql(runtime);
  const diagnostics: SparqlConstructDiagnostic[] = [...projection.diagnostics, ...translated.diagnostics];
  // Structural limits of the default profile. Custom N3 runtimes can define
  // their own quantity representation; these checks never implement arithmetic.
  if (input.rules === undefined || input.rules === defaultSparqlMappingRules) {
    const units = new Set<string>();
    const Q = 'http://qudt.org/schema/qudt/';
    for (const shape of compileShaclShapeGraph(consumer, 'out').shapes) {
      const numeric = shape.propertyPlans.find(p => p.path.type === 'predicate' && p.path.predicate === Q + 'numericValue');
      const unit = shape.propertyPlans.find(p => p.path.type === 'predicate' && p.path.predicate === Q + 'unit');
      if (!numeric) continue;
      const targets = [...numeric.units, ...unit?.hasValues ?? []];
      targets.forEach(u => units.add(u));
      if (!targets.length) continue;
      if (!shape.targetClasses.length || !numeric.required || !unit?.required || unit.hasValues.length !== 1
        || new Set(targets).size !== 1) diagnostics.push({ severity: 'error', shape: shape.shape,
        message: 'The default QUDT rules require a target class, required direct numericValue and unit paths, and one consistent output unit declared with sh:hasValue.' });
    }
    if (units.size > 1) diagnostics.push({ severity: 'error', message: 'The default QUDT rules support one output unit per runtime. Use separate programs or custom rules for multiple quantity representations.' });
  }
  if (!provider.length) diagnostics.push({ severity: 'error', message: 'Provider SHACL input is empty.' });
  const failed = diagnostics.some(d => d.severity === 'error');
  return { query: failed ? null : projection.query, program: failed ? null : translated.program, runtime, mappings: projection.mappings, diagnostics };
}
