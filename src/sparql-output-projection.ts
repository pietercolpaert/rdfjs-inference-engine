import type { Quad, Term } from '@rdfjs/types';
import { compileShaclShapeGraph, type CompiledShaclPath } from './shacl-shape-planning';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';
type Step = { predicate: string; inverse: boolean };
export interface SparqlConstructMapping {
  providerShape: string;
  consumerShape: string;
  sourcePaths: string[];
  targetPath: string;
  required: boolean;
}
interface Diagnostic { severity: 'error' | 'warning'; message: string; shape?: string; path?: string }
/** Select consumer fields from already inferred facts. This function performs
 * no ontology entailment, arithmetic, conversion or inference-rule selection.
 */
export function compileOutputProjection(input: { shaclOut: Iterable<Quad> }) {
  const quads = Array.from(input.shaclOut);
  const plan = compileShaclShapeGraph(quads, 'out');
  const attached = new Set(quads.filter(q => q.predicate.value === SH + 'property').map(q => id(q.object)));
  const shapes = plan.shapes.filter(shape => !attached.has(shape.shape));
  const diagnostics: Diagnostic[] = [], mappings: SparqlConstructMapping[] = [], templates: string[] = [], branches: string[] = [];
  const report = (severity: Diagnostic['severity'], message: string, shape?: string, path?: string) => diagnostics.push({ severity, message, shape, path });
  const supported = new Set(['NodeShape', 'PropertyShape', 'targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf',
    'property', 'path', 'inversePath', 'alternativePath', 'zeroOrMorePath', 'oneOrMorePath', 'zeroOrOnePath',
    'minCount', 'maxCount', 'datatype', 'class', 'nodeKind', 'hasValue', 'in', 'unit', 'closed', 'ignoredProperties',
    'name', 'description', 'order', 'message', 'severity']);
  const compiled = new Set(plan.shapes.flatMap(shape => shape.propertyPlans.map(p => p.propertyShape)));
  for (const q of quads) {
    if (q.predicate.value === SH + 'path' && !compiled.has(id(q.subject))) report('error', 'A SHACL path could not be compiled, or its property shape is unattached.', id(q.subject));
    if (q.predicate.value.startsWith(SH) && !supported.has(q.predicate.value.slice(SH.length))) report('error', `Unsupported consumer constraint: ${q.predicate.value}.`, id(q.subject));
    if (q.predicate.value === SH + 'unit' && q.object.termType !== 'NamedNode') report('error', 'sh:unit must specify one unit IRI.', id(q.subject));
    if (q.predicate.value.startsWith('https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#')) report('error', 'CDT output encodings require custom supported N3 rules and are not supported by this projection.', id(q.subject));
  }
  if (!shapes.length) report('error', 'Consumer input must contain a usable SHACL shape.');
  let branch = 0;
  for (const shape of shapes) {
    // Each target class is a separate selector. Never assert a class merely
    // because another target selected a focus node.
    const selectors: { pattern: (root: string) => string; type?: string }[] = [];
    shape.targetClasses.forEach(type => selectors.push({ type, pattern: root => `${root} ${iri(RDF + 'type')} ${iri(type)} .` }));
    shape.targetNodes.forEach(node => selectors.push({ pattern: root => `VALUES ${root} { ${termById(quads, node)} }` }));
    shape.targetSubjectsOf.forEach(p => selectors.push({ pattern: root => `${root} ${iri(p)} ?anchor${branch} .` }));
    shape.targetObjectsOf.forEach(p => selectors.push({ pattern: root => `?anchor${branch} ${iri(p)} ${root} .` }));
    if (!selectors.length) shape.propertyPlans.forEach(p => selectors.push({ pattern: root => `${root} ${pathText(p.path)} ?anchor${branch} .` }));
    if (!selectors.length) { report('error', 'Consumer shape needs a target or property path.', shape.shape); continue; }
    for (const selector of selectors) {
      const root = `?focus${++branch}`, where = [selector.pattern(root)];
      if (selector.type) templates.push(`${root} ${iri(RDF + 'type')} ${iri(selector.type)} .`);
      for (const type of shape.classes) { where.push(`${root} ${iri(RDF + 'type')} ${iri(type)} .`); templates.push(`${root} ${iri(RDF + 'type')} ${iri(type)} .`); }
      for (const [index, property] of shape.propertyPlans.entries()) {
        if (property.maxCount === 0) continue;
        const steps = linearPath(property.path);
        if (!steps) { report('error', 'Consumer paths must be predicates, inverse paths, or sequences; alternative and repeated output paths are ambiguous to construct.', shape.shape, property.pathText); continue; }
        const value = `?value${branch}_${index}`;
        const nodes = [root, ...steps.slice(1).map((_, i) => `?node${branch}_${index}_${i}`), value];
        let pattern = steps.map((step, i) => triple(nodes[i], step, nodes[i + 1])).join(' ');
        const filters: string[] = [];
        if (property.datatype) filters.push(`isLiteral(${value}) && DATATYPE(${value}) = ${iri(property.datatype)}`);
        if (property.inValues.length) filters.push(`${value} IN (${property.inValues.map(v => termById(quads, v)).join(', ')})`);
        if (property.nodeKind) {
          const kinds: Record<string, string> = { IRI: `isIRI(${value})`, BlankNode: `isBlank(${value})`, Literal: `isLiteral(${value})`,
            BlankNodeOrIRI: `!isLiteral(${value})`, BlankNodeOrLiteral: `!isIRI(${value})`, IRIOrLiteral: `!isBlank(${value})` };
          const filter = kinds[property.nodeKind.slice(SH.length)];
          if (filter) filters.push(filter); else report('error', 'Unknown sh:nodeKind.', shape.shape, property.pathText);
        }
        if (property.class) {
          pattern += ` ${value} ${iri(RDF + 'type')} ${iri(property.class)} .`;
          templates.push(`${value} ${iri(RDF + 'type')} ${iri(property.class)} .`);
        }
        if (filters.length) pattern += ` FILTER (${filters.map(f => `(${f})`).join(' && ')})`;
        const required = property.required || property.hasValues.length > 0;
        where.push(required ? pattern : `OPTIONAL { ${pattern} }`);
        for (const constant of property.hasValues) where.push(`FILTER EXISTS { ${root} ${pathText(property.path)} ${termById(quads, constant)} . }`);
        templates.push(...steps.map((step, i) => triple(nodes[i], step, nodes[i + 1])));
        if (!mappings.some(m => m.consumerShape === shape.shape && m.targetPath === property.pathText)) mappings.push({ providerShape: shape.shape,
          consumerShape: shape.shape, sourcePaths: [property.pathText], targetPath: property.pathText, required });
        if ((property.minCount ?? 0) > 1 || property.maxCount !== undefined) report('warning', 'Cardinality is not repaired or validated; validate the constructed message against the consumer shape.', shape.shape, property.pathText);
      }
      branches.push(`{\n    ${where.join('\n    ')}\n  }`);
    }
  }
  return { query: diagnostics.some(d => d.severity === 'error') ? null : `CONSTRUCT {\n  ${[...new Set(templates)].join('\n  ')}\n}\nWHERE {\n  ${branches.join('\n  UNION\n  ')}\n}\n`, mappings, diagnostics };
}
function iri(value: string): string {
  if (/[<>"{}|^`\\\u0000-\u0020]/u.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error(`Invalid absolute IRI: ${value}`);
  return `<${value}>`;
}
function id(term: Term): string {
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType === 'Literal') return term.language ? `"${term.value}"@${term.language}` : `"${term.value}"^^${term.datatype.value}`;
  return term.value;
}
function termById(quads: Quad[], value: string): string {
  const term = quads.flatMap(q => [q.subject, q.object]).find(t => id(t) === value);
  if (!term) throw new Error(`Cannot find RDF term: ${value}`);
  if (term.termType === 'NamedNode') return iri(term.value);
  if (term.termType === 'Literal') return JSON.stringify(term.value) + (term.language ? `@${term.language}` : `^^${iri(term.datatype.value)}`);
  throw new Error('Blank nodes cannot be used as fixed query values. Use an IRI or literal.');
}
function triple(subject: string, step: Step, object: string): string { return step.inverse ? `${object} ${iri(step.predicate)} ${subject} .` : `${subject} ${iri(step.predicate)} ${object} .`; }
function linearPath(path: CompiledShaclPath): Step[] | undefined {
  if (path.type === 'predicate') return [{ predicate: path.predicate, inverse: false }];
  if (path.type === 'inverse') return linearPath(path.path)?.reverse().map(step => ({ ...step, inverse: !step.inverse }));
  if (path.type === 'sequence') { const items = path.items.map(linearPath); return items.every(item => item !== undefined) ? items.flat() as Step[] : undefined; }
  return undefined;
}
function pathText(path: CompiledShaclPath): string {
  switch (path.type) {
    case 'predicate': return iri(path.predicate);
    case 'inverse': return `^(${pathText(path.path)})`;
    case 'sequence': return `(${path.items.map(pathText).join('/')})`;
    case 'alternative': return `(${path.alternatives.map(pathText).join('|')})`;
    case 'zeroOrMore': return `(${pathText(path.path)})*`;
    case 'oneOrMore': return `(${pathText(path.path)})+`;
    case 'zeroOrOne': return `(${pathText(path.path)})?`;
  }
}
