import type { Quad, Term } from '@rdfjs/types';
import { compileShaclShapeGraph, compileShaclPath, type CompiledShaclPath } from './shacl-shape-planning';
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
  const diagnostics: Diagnostic[] = [], mappings: SparqlConstructMapping[] = [], templates: string[] = [], branches: string[] = [];
  const subjects = new Map<string, Quad[]>();
  for (const q of quads) { const key = id(q.subject); if (!subjects.has(key)) subjects.set(key, []); subjects.get(key)!.push(q); }
  const objects = (shape: string, local: string): Term[] => (subjects.get(shape) ?? []).filter(q => q.predicate.value === SH + local).map(q => q.object);
  const active = (shape: string) => !objects(shape, 'deactivated').some(t => t.value === 'true' || t.value === '1');
  const report = (severity: Diagnostic['severity'], message: string, shape?: string, path?: string) => {
    if (!diagnostics.some(d => d.severity === severity && d.message === message && d.shape === shape && d.path === path)) diagnostics.push({ severity, message, shape, path });
  };
  let variable = 0;
  const fresh = (label: string) => `?${label}${++variable}`;
  const list = (head: Term): Term[] => {
    const values: Term[] = [], seen = new Set<string>();
    let cursor = head;
    while (cursor.value !== RDF + 'nil') {
      const key = id(cursor);
      if (seen.has(key)) { report('error', 'Cyclic SHACL list.', key); break; }
      seen.add(key);
      const entries = subjects.get(key) ?? [];
      const first = entries.find(q => q.predicate.value === RDF + 'first')?.object;
      const rest = entries.find(q => q.predicate.value === RDF + 'rest')?.object;
      if (!first || !rest) { report('error', 'Malformed SHACL list.', key); break; }
      values.push(first); cursor = rest;
    }
    return values;
  };
  const pathCache = new Map<string, CompiledShaclPath | undefined>();
  const path = (shape: string) => {
    if (!pathCache.has(shape)) {
      const term = objects(shape, 'path')[0];
      pathCache.set(shape, term ? compileShaclPath(term, quads) : undefined);
      if (term && !pathCache.get(shape)) report('error', 'A SHACL path could not be compiled.', shape);
    }
    return pathCache.get(shape);
  };
  const supported = new Set(['NodeShape', 'PropertyShape', 'targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf',
    'property', 'path', 'inversePath', 'alternativePath', 'zeroOrMorePath', 'oneOrMorePath', 'zeroOrOnePath',
    'minCount', 'maxCount', 'datatype', 'class', 'nodeKind', 'hasValue', 'in', 'unit', 'closed', 'ignoredProperties',
    'name', 'description', 'order', 'message', 'severity', 'deactivated', 'node', 'or', 'and', 'not', 'xone',
    'pattern', 'flags', 'minLength', 'maxLength', 'languageIn', 'uniqueLang',
    'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive',
    'qualifiedValueShape', 'qualifiedMinCount', 'qualifiedMaxCount', 'qualifiedValueShapesDisjoint']);
  const validationOnly = new Set(['uniqueLang', 'qualifiedValueShape', 'qualifiedMinCount', 'qualifiedMaxCount', 'qualifiedValueShapesDisjoint']);
  for (const q of quads) {
    const shape = id(q.subject), local = q.predicate.value.slice(SH.length);
    if (!active(shape)) continue;
    if (q.predicate.value.startsWith(SH) && !supported.has(local)) report('warning', `Consumer constraint is advisory and is not validated: ${q.predicate.value}.`);
    if (validationOnly.has(local) && q.predicate.value.startsWith(SH)) report('warning',
      'Language uniqueness and qualified cardinality constraints require validation of the complete constructed graph; this projection does not repair or validate them.');
    if (q.predicate.value === SH + 'unit' && q.object.termType !== 'NamedNode') report('error', 'sh:unit must specify one unit IRI.', shape);
    if (q.predicate.value.startsWith('https://www.pieter.pm/rdfjs-inference-engine/ns/qudt-inference#')) report('error', 'CDT output encodings require custom supported N3 rules and are not supported by this projection.', shape);
  }
  const referenced = new Set<string>();
  for (const q of quads) {
    if ([SH + 'property', SH + 'node', SH + 'not', SH + 'qualifiedValueShape'].includes(q.predicate.value)) referenced.add(id(q.object));
    if ([SH + 'or', SH + 'and', SH + 'xone'].includes(q.predicate.value)) list(q.object).forEach(t => referenced.add(id(t)));
  }
  const targeted = plan.shapes.filter(s => s.targetClasses.length || s.targetNodes.length || s.targetSubjectsOf.length || s.targetObjectsOf.length);
  const shapes = (targeted.length ? targeted : plan.shapes.filter(s => !referenced.has(s.shape))).filter(s => active(s.shape));
  if (!shapes.length) report('error', 'Consumer input must contain an active SHACL shape with a target or property path.');
  report('warning', 'Consumer shapes guide best-effort field selection. Value constraints and cardinality are not validated or repaired; all existing values on selected paths are retained.');
  const positiveReferences = (shape: string): string[] => [
    ...objects(shape, 'node').map(id),
    ...objects(shape, 'qualifiedValueShape').map(id),
    ...['or', 'and', 'xone'].flatMap(local => objects(shape, local).flatMap(head => list(head).map(id))),
  ];
  const emit = (where: string[], triples: string[]) => {
    templates.push(...triples); branches.push(`{\n    ${where.join('\n    ')}\n  }`);
  };
  const project = (shape: string, root: string, where: string[], stack: Set<string>) => {
    if (!active(shape)) return;
    if (!subjects.has(shape)) { report('error', 'Referenced SHACL shape has no definition.', shape); return; }
    if (stack.has(shape)) { report('warning', 'Recursive consumer shape traversal stops at the repeated shape; deeper fields may need a separate projection.', shape); return; }
    const next = new Set(stack).add(shape);
    const fields = objects(shape, 'property').map(id);
    if (path(shape)) fields.push(shape);
    for (const field of fields) {
      if (!active(field)) continue;
      const p = path(field);
      if (!p) { report('error', 'Property shape needs a usable SHACL path.', field); continue; }
      const steps = linearPath(p);
      if (!steps) { report('error', 'Consumer paths must be predicates, inverse paths, or sequences; alternative and repeated output paths are ambiguous to construct.', shape, pathText(p)); continue; }
      const value = fresh('value'), nodes = [root, ...steps.slice(1).map(() => fresh('node')), value];
      const triples = steps.map((step, i) => triple(nodes[i], step, nodes[i + 1]));
      const pattern = [...where, ...triples];
      emit(pattern, triples);
      const required = Number(objects(field, 'minCount')[0]?.value ?? 0) > 0 || objects(field, 'hasValue').length > 0;
      const targetPath = plan.shapes.flatMap(s => s.propertyPlans).find(p => p.propertyShape === field)?.pathText ?? pathText(p);
      if (!mappings.some(m => m.consumerShape === shape && m.targetPath === targetPath)) mappings.push({ providerShape: shape,
        consumerShape: shape, sourcePaths: [targetPath], targetPath, required });
      if (Number(objects(field, 'minCount')[0]?.value ?? 0) > 1 || objects(field, 'maxCount').length) report('warning',
        'Cardinality is not repaired or validated; validate the constructed message against the consumer shape.');
      const type = fresh('type');
      if (objects(field, 'class').length || objects(field, 'node').length || ['or', 'and', 'xone'].some(local => objects(field, local).length))
        emit([...pattern, `${value} ${iri(RDF + 'type')} ${type} .`], [`${value} ${iri(RDF + 'type')} ${type} .`]);
      for (const child of positiveReferences(field)) project(child, value, pattern, next);
    }
    // Logical alternatives supply candidate fields, rather than rejecting data
    // that fails their validation constraints. Negative shapes supply no fields.
    if (!path(shape)) for (const child of positiveReferences(shape)) project(child, root, where, next);
  };

  for (const shape of shapes) {
    const selectors: { pattern: (root: string) => string; type?: string }[] = [];
    shape.targetClasses.forEach(type => selectors.push({ type, pattern: root => `${root} ${iri(RDF + 'type')} ${iri(type)} .` }));
    shape.targetNodes.forEach(node => selectors.push({ pattern: root => `VALUES ${root} { ${termById(quads, node)} }` }));
    shape.targetSubjectsOf.forEach(p => selectors.push({ pattern: root => `${root} ${iri(p)} ${fresh('anchor')} .` }));
    shape.targetObjectsOf.forEach(p => selectors.push({ pattern: root => `${fresh('anchor')} ${iri(p)} ${root} .` }));
    if (!selectors.length) shape.propertyPlans.forEach(p => selectors.push({ pattern: root => `${root} ${pathText(p.path)} ${fresh('anchor')} .` }));
    if (!selectors.length) { report('error', 'Consumer shape needs a target or property path.', shape.shape); continue; }
    for (const selector of selectors) {
      const root = fresh('focus'), where = [selector.pattern(root)];
      const start = branches.length;
      if (selector.type) emit([], [`${root} ${iri(RDF + 'type')} ${iri(selector.type)} .`]);
      for (const type of shape.classes) {
        const subject = fresh('typedFocus');
        emit([`${root} ${iri(RDF + 'type')} ${iri(type)} .`, `BIND (${root} AS ${subject})`],
          [`${subject} ${iri(RDF + 'type')} ${iri(type)} .`]);
      }
      project(shape.shape, root, [], new Set());
      const fields = branches.splice(start);
      // Select the focus once, then emit each field independently. Joining all
      // optional nested fields would multiply multi-valued heritage records.
      if (!fields.length) continue;
      branches.push(`{\n    ${where.join('\n    ')}\n    { ${fields.join('\n    UNION\n    ')} }\n  }`);
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
