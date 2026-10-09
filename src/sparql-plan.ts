import { Parser, Generator } from 'sparqljs';
import type { SparqlRuntimeProgram } from './n3-to-sparql';

// SPARQL.js has a heterogeneous recursive AST. Keep transformations confined to
// the generated subset and preserve RDF/JS terms (including literal datatypes).
type Ast = any;
const parser = () => new Parser();
const generator = new Generator();
const variable = (value: string) => ({ termType: 'Variable', value });
const operation = (operator: string, ...args: Ast[]) => ({ type: 'operation', operator, args });
const bind = (expression: Ast, target: Ast) => ({ type: 'bind', variable: target, expression });
const group = (patterns: Ast[]) => ({ type: 'group', patterns });
const bgp = (triple: Ast) => ({ type: 'bgp', triples: [triple] });
const union = (patterns: Ast[]) => ({ type: 'union', patterns });
const filter = (expression: Ast) => ({ type: 'filter', expression });
const positions = ['subject', 'predicate', 'object'] as const;
const same = (a: Ast, b: Ast) => JSON.stringify(a) === JSON.stringify(b);
function map(value: Ast, transform: (value: Ast) => Ast): Ast {
  if (Array.isArray(value)) return value.map(v => map(v, transform));
  if (!value || typeof value !== 'object') return value;
  if (value.termType) return transform(value);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, map(v, transform)]));
}
function positive(value: Ast): boolean {
  if (!value || typeof value !== 'object' || value.termType) return true;
  if (['optional', 'minus', 'service', 'query'].includes(value.type)) return false;
  if (['notexists', 'exists', 'rand', 'uuid', 'struuid', 'bnode', 'now'].includes(value.operator)) return false;
  return Object.values(value).every(v => Array.isArray(v) ? v.every(positive) : positive(v));
}
function references(value: Ast, graph: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'graph' && value.name?.value === graph) return true;
  return Object.values(value).some(v => Array.isArray(v) ? v.some(x => references(x, graph)) : references(v, graph));
}

export interface SparqlPlanOptimization {
  program: SparqlRuntimeProgram;
  query: string;
  /** True when the output query can be executed directly on the input RDF. */
  standalone: boolean;
  originalRules: number;
}

/** Compile views during generation. The exported artifact contains only SPARQL.
 * Size limits are optimization limits: exceeding them retains the original plan.
 */
export function optimizeSparqlPlan(program: SparqlRuntimeProgram, query: string): SparqlPlanOptimization {
  const originalRules = program.rules.length;
  let fresh = 0;
  const used = new Set<string>();
  const parse = (text: string): Ast => {
    const ast = parser().parse(text);
    map(ast, term => { if (term.termType === 'Variable') used.add(term.value); return term; });
    return ast;
  };
  const next = () => {
    let name: string;
    do { name = `__view_${++fresh}`; } while (used.has(name));
    used.add(name); return variable(name);
  };
  const rename = (ast: Ast) => {
    const names = new Map<string, Ast>();
    return map(ast, term => {
      if (term.termType !== 'Variable') return term;
      if (!names.has(term.value)) names.set(term.value, next());
      return names.get(term.value);
    });
  };
  const rules = program.rules.map(rule => ({ ...rule, ast: parse(rule.query), checkAsts: (rule.checks ?? []).map(parse) }));
  const output = parse(query);
  const seeds = program.seedQuery ? parse(program.seedQuery).template : [];
  // Eager current-store negation never retracts previously derived heads. Keep
  // the original order and visibility for programs exposing that extension.
  const eagerNegation = rules.some(r => !r.graph && !positive(r.ast.where));
  const publicHeads = rules.filter(r => !r.graph).flatMap(r => r.ast.template);
  const stable = (node: Ast): boolean => {
    if (!node || typeof node !== 'object' || node.termType) return true;
    if (node.type === 'graph') return false;
    if (node.type === 'bgp' && node.triples.some((triple: Ast) => publicHeads.some((head: Ast) =>
      positions.every(p => triple[p]?.termType === 'Variable' || head[p]?.termType === 'Variable' || same(triple[p], head[p]))))) return false;
    return Object.values(node).every(v => Array.isArray(v) ? v.every(stable) : stable(v));
  };

  // A constructed triple is a relational view. A SELECT scope prevents producer
  // locals and BIND targets from capturing variables at the call site. sameTerm
  // enforces RDF matching, rather than SPARQL numeric value equality.
  const view = (target: Ast, head: Ast, where: Ast[]): Ast | null => {
    const patterns = [...where], projected: Ast[] = [];
    const bindings = new Map<string, Ast>();
    for (const position of positions) {
      const expected = target[position], actual = head[position];
      if (!expected?.termType || !actual?.termType || actual.termType === 'BlankNode') return null;
      if (expected.termType === 'Variable') {
        const prior = bindings.get(expected.value);
        if (prior) patterns.push(filter(operation('sameterm', prior, actual)));
        else bindings.set(expected.value, actual);
      } else if (actual.termType === 'Variable') patterns.push(filter(operation('sameterm', actual, expected)));
      else if (!same(expected, actual)) return null;
    }
    // CONSTRUCT omits unbound or invalid triples; unfolding must do the same.
    for (const position of positions) if (head[position].termType === 'Variable') patterns.push(filter(operation('bound', head[position])));
    patterns.push(filter(operation('||', operation('isiri', head.subject), operation('isblank', head.subject))));
    patterns.push(filter(operation('isiri', head.predicate)));
    for (const [name, expression] of bindings) {
      const targetVariable = variable(name);
      patterns.push(bind(expression, targetVariable)); projected.push(targetVariable);
    }
    // Ground patterns still need a SELECT variable for SPARQL syntax.
    if (!projected.length) { const dummy = next(); patterns.push(bind({ termType: 'Literal', value: '1', datatype: { termType: 'NamedNode', value: 'http://www.w3.org/2001/XMLSchema#integer' } }, dummy)); projected.push(dummy); }
    return { type: 'query', queryType: 'SELECT', distinct: true, variables: projected, where: patterns };
  };

  // Try a fully unfolded consumer query for the strictly positive, acyclic
  // subset. Recursive dependencies, negation, paths and identity-sensitive
  // static blank nodes fall back to materialization, never partial unfolding.
  if (program.projectionSource === 'closure' && !program.auxiliaryGraphs?.length && rules.every(r => !r.graph && !r.checks?.length && positive(r.ast.where))) {
    let budget = 0;
    const unfoldTriple = (triple: Ast, stack: string[]): Ast => {
      if (++budget > 256 || triple.predicate.termType !== 'NamedNode') throw new Error('View expansion limit or property path.');
      const predicate = triple.predicate.value;
      const alternatives: Ast[] = [group([bgp(triple)])];
      for (const fact of seeds) {
        if (!positions.every(p => triple[p].termType === 'Variable' || fact[p].termType === 'BlankNode' || same(triple[p], fact[p]))) continue;
        if (positions.some(p => fact[p].termType === 'BlankNode')) throw new Error('Static blank-node identity needs materialization.');
        const branch = view(triple, fact, []);
        if (branch) alternatives.push(group([branch]));
      }
      for (const rule of rules) for (let i = 0; i < rule.ast.template.length; i++) {
        const renamed = rename(rule.ast), head = renamed.template[i];
        if (head.predicate.termType !== 'NamedNode') throw new Error('Variable predicate in producer.');
        if (!positions.every(p => triple[p].termType === 'Variable' || head[p].termType === 'Variable' || same(triple[p], head[p]))) continue;
        if (stack.includes(predicate)) throw new Error('Recursive view.');
        const branch = view(triple, head, unfoldPatterns(renamed.where, [...stack, predicate]));
        if (branch) alternatives.push(group([branch]));
      }
      return alternatives.length === 1 ? alternatives[0] : union(alternatives);
    };
    const unfoldPatterns = (patterns: Ast[], stack: string[]): Ast[] => patterns.flatMap(pattern => {
      if (pattern.type === 'bgp') return pattern.triples.map((t: Ast) => unfoldTriple(t, stack));
      if (pattern.type === 'group') return [{ ...pattern, patterns: unfoldPatterns(pattern.patterns, stack) }];
      // A UNION child can itself be a multi-triple BGP. Splitting it must keep
      // those triples joined inside that branch, rather than creating OR arms.
      if (pattern.type === 'union') return [{ ...pattern, patterns: pattern.patterns.map((branch: Ast) => group(unfoldPatterns([branch], stack))) }];
      if (['bind', 'filter'].includes(pattern.type) && positive(pattern)) return [pattern];
      throw new Error('Unsupported view pattern.');
    });
    try {
      const unfolded = generator.stringify({ ...output, where: unfoldPatterns(output.where, []) });
      if (unfolded.length <= 80000) return { program: { ...program, seedQuery: null, rules: [] }, query: unfolded, standalone: true, originalRules };
    } catch { /* Materialization preserves the full supported semantics. */ }
  }

  // Unfold small positive private relations. Negated relations remain stored:
  // their eager, monotonic materialization is observably different from inlining.
  for (const graph of program.auxiliaryGraphs ?? []) {
    const producers = rules.filter(r => r.graph === graph);
    if (!producers.length || producers.some(r => r.checks?.length || !positive(r.ast.where) || references(r.ast.where, graph))) continue;
    if (eagerNegation && producers.some(r => !stable(r.ast.where))) continue;
    const rewrite = (node: Ast): Ast => {
      if (!node || typeof node !== 'object' || node.termType) return node;
      if (Array.isArray(node)) return node.map(rewrite);
      if (node.type === 'graph' && node.name.value === graph) {
        if (!node.patterns.every((p: Ast) => p.type === 'bgp')) throw new Error('Complex helper graph.');
        return group(node.patterns.flatMap((p: Ast) => p.triples.map((triple: Ast) => {
          const alternatives: Ast[] = [];
          for (const producer of producers) for (let i = 0; i < producer.ast.template.length; i++) {
            const renamed = rename(producer.ast);
            const branch = view(triple, renamed.template[i], renamed.where);
            if (branch) alternatives.push(group([branch]));
          }
          return alternatives.length ? union(alternatives) : filter(operation('=', { termType: 'NamedNode', value: 'urn:false' }, { termType: 'NamedNode', value: 'urn:true' }));
        })));
      }
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v)]));
    };
    try {
      const rewritten = rules.filter(r => r.graph !== graph).map(r => ({ ...r, ast: rewrite(r.ast), checkAsts: rewrite(r.checkAsts) }));
      if (rewritten.some(r => generator.stringify(r.ast).length > 80000 || r.checkAsts.some((a: Ast) => generator.stringify(a).length > 80000))) continue;
      rules.splice(0, rules.length, ...rewritten);
    } catch { /* Keep this helper materialized. */ }
  }

  // Fuse adjacent positive queries with the same destination. Constructing a
  // generic triple per UNION branch avoids template variables leaking between
  // branches, including constant heads. Fixed-point evaluation preserves chains.
  const optimized: SparqlRuntimeProgram['rules'] = [];
  for (let i = 0; i < rules.length;) {
    const batch = [rules[i++]];
    if ((!eagerNegation || batch[0].graph) && positive(batch[0].ast.where)) while (i < rules.length && rules[i].graph === batch[0].graph && positive(rules[i].ast.where)) batch.push(rules[i++]);
    let text: string;
    if (batch.length === 1) text = generator.stringify(batch[0].ast);
    else {
      const s = next(), p = next(), o = next();
      const branches = batch.flatMap(rule => rule.ast.template.map((_: Ast, index: number) => {
        const renamed = rename(rule.ast), head = renamed.template[index];
        return group([ ...renamed.where, bind(head.subject, s), bind(head.predicate, p), bind(head.object, o) ]);
      }));
      const fused: Ast = { type: 'query', queryType: 'CONSTRUCT', prefixes: {}, template: [{ subject: s, predicate: p, object: o }], where: [union(branches)] };
      text = generator.stringify(fused);
    }
    if (text.length > 80000 && batch.length > 1) {
      optimized.push(...batch.map(r => ({ rule: r.rule, ...(r.graph ? { graph: r.graph } : {}), query: generator.stringify(r.ast), ...(r.checkAsts.length ? { checks: r.checkAsts.map((a: Ast) => generator.stringify(a)) } : {}) })));
      continue;
    }
    const checks = batch.flatMap(r => r.checkAsts.map((a: Ast) => generator.stringify(a)));
    optimized.push({ rule: batch[0].rule, ...(batch[0].graph ? { graph: batch[0].graph } : {}), query: text, ...(checks.length ? { checks: [...new Set(checks)] } : {}) });
  }
  const auxiliaryGraphs = (program.auxiliaryGraphs ?? []).filter(graph => optimized.some(r => r.graph === graph));
  return { program: { ...program, rules: optimized, auxiliaryGraphs }, query, standalone: false, originalRules };
}
