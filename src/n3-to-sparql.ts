import type { Quad, Term } from '@rdfjs/types';

const { Parser } = require('n3') as { Parser: new (options: object) => { parse(text: string): Quad[] } };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const LOG = 'http://www.w3.org/2000/10/swap/log#';
const MATH = 'http://www.w3.org/2000/10/swap/math#';
const STRING = 'http://www.w3.org/2000/10/swap/string#';
const DT = 'https://eyereasoner.github.io/eyeling/datatype#';
const LIST = 'http://www.w3.org/2000/10/swap/list#';
type Value = Term | { kind: 'list'; items: Value[] } | { kind: 'formula'; atoms: Atom[] };
type Atom = { s: Value; p: Value; o: Value; auxiliaryGraph?: string };
type Rule = { body: Atom[]; head: Atom[]; index: number; auxiliaryGraph?: string };
export interface N3SparqlDiagnostic { severity: 'error' | 'warning'; message: string; rule?: number; builtin?: string }
export interface SparqlRuntimeProgram {
  /** Consumer projections can retain identity fields from the input graph. */
  projectionSource?: 'closure';
  /** Private helper relations; ordinary rule patterns only see the default graph. */
  auxiliaryGraphs?: string[];
  /** Execute once, before the rules. Static facts are not output facts. */
  seedQuery: string | null;
  /** Execute in source order until no new facts are added. */
  rules: { rule: number; query: string; graph?: string; checks?: string[] }[];
}
export interface N3SparqlResult { program: SparqlRuntimeProgram | null; diagnostics: N3SparqlDiagnostic[] }
export interface N3SparqlOptions { baseIRI?: string }

/** Translate an N3 forward runtime, including nonrecursive backward helpers.
 * No reasoner is used during execution: all inference happens in the emitted SPARQL.
 * Unsupported constructs fail the entire translation, never just one rule.
 */
export function translateN3RuntimeToSparql(runtime: string, options: N3SparqlOptions = {}): N3SparqlResult {
  const diagnostics: N3SparqlDiagnostic[] = [];
  const rules: SparqlRuntimeProgram['rules'] = [];
  try {
    const quads = new Parser({ format: 'N3', baseIRI: options.baseIRI, isImpliedBy: true }).parse(runtime);
    const graphs = new Map<string, Quad[]>();
    for (const q of quads) {
      const key = q.graph.value;
      if (!graphs.has(key)) graphs.set(key, []);
      graphs.get(key)!.push(q);
    }
    const formulaIds = new Set<string>();
    const value = (term: Term, graph: Quad[], visiting = new Set<string>()): Value => {
      if (term.termType !== 'BlankNode') return term;
      if (visiting.has(term.value)) throw new Error('Cyclic N3 lists or formulas cannot be translated.');
      const next = new Set(visiting).add(term.value);
      if (graphs.has(term.value)) {
        formulaIds.add(term.value);
        return { kind: 'formula', atoms: atoms(graphs.get(term.value)!, next) };
      }
      const first = graph.find(q => q.subject.equals(term) && q.predicate.value === RDF + 'first');
      if (!first) return term;
      const rest = graph.find(q => q.subject.equals(term) && q.predicate.value === RDF + 'rest');
      if (!rest) throw new Error('Malformed N3 list: missing rdf:rest.');
      const tail = rest.object.value === RDF + 'nil' ? { kind: 'list' as const, items: [] } : value(rest.object, graph, next);
      if (!('kind' in tail) || tail.kind !== 'list') throw new Error('Malformed N3 list tail.');
      return { kind: 'list', items: [value(first.object, graph, next), ...tail.items] };
    };
    const atoms = (graph: Quad[], visiting = new Set<string>()): Atom[] => graph
      .filter(q => q.subject.termType !== 'BlankNode' || (q.predicate.value !== RDF + 'first' && q.predicate.value !== RDF + 'rest'))
      .map(q => ({ s: value(q.subject, graph, visiting), p: value(q.predicate, graph, visiting), o: value(q.object, graph, visiting) }));
    const forward: Rule[] = [], backward: Rule[] = [], seeds: Quad[] = [];
    for (const q of graphs.get('') ?? []) {
      if ([LOG + 'implies', LOG + 'isImpliedBy'].includes(q.predicate.value)) {
        const left = value(q.subject, []), right = value(q.object, []);
        if (!('kind' in left) || left.kind !== 'formula' || !('kind' in right) || right.kind !== 'formula') throw new Error('Rule implications must connect two formulas.');
        const index = forward.length + backward.length + 1;
        (q.predicate.value === LOG + 'implies' ? forward : backward).push({
          body: q.predicate.value === LOG + 'implies' ? left.atoms : right.atoms,
          head: q.predicate.value === LOG + 'implies' ? right.atoms : left.atoms, index,
        });
      } else seeds.push(q);
    }
    for (const key of graphs.keys()) if (key && !formulaIds.has(key)) throw new Error('Named graphs and unattached quoted formulas are not supported in N3 runtimes.');
    const helpers = new Map<string, Rule[]>();
    for (const rule of backward) {
      if (rule.head.length !== 1 || !isTerm(rule.head[0].p) || rule.head[0].p.termType !== 'NamedNode') {
        diagnostics.push({ severity: 'error', rule: rule.index, message: 'Backward helpers require one head atom with a fixed predicate.' });
        continue;
      }
      const key = rule.head[0].p.value;
      helpers.set(key, [...helpers.get(key) ?? [], rule]);
    }
    const reachable = new Set<string>();
    const visit = (atoms: Atom[], stack: string[] = []) => {
      for (const atom of atoms) {
        if (!isTerm(atom.o) && atom.o.kind === 'formula') visit(atom.o.atoms, stack);
        const predicate = isTerm(atom.p) ? atom.p.value : '';
        if (!helpers.has(predicate)) continue;
        if (stack.includes(predicate)) throw new Error(`Recursive backward helper cannot be inlined: ${predicate}`);
        if (reachable.has(predicate)) continue;
        reachable.add(predicate);
        for (const helper of helpers.get(predicate)!) visit(helper.body, [...stack, predicate]);
      }
    };
    forward.forEach(rule => visit(rule.body));
    const materialized = new Map<string, string>();
    // Safe RDF-valued helpers can be evaluated as relations, once per round,
    // instead of distributing all their alternatives across each calling rule.
    for (const [predicate, definitions] of helpers) {
      if (!reachable.has(predicate)) continue;
      const safe = definitions.every(rule => {
        if (!isTerm(rule.head[0].s) || !isTerm(rule.head[0].o)) return false;
        try {
          const compiled = compileBody(rule.body, [], rule.index);
          return variables(rule.head[0]).every(v => compiled.bound.has(v));
        } catch { return false; }
      });
      if (safe) materialized.set(predicate, `urn:rdfjs:sparql:helper:${encodeURIComponent(predicate)}`);
    }
    // A relation must not depend on an input-bound helper that needs inlining.
    let removed = true;
    while (removed) {
      removed = false;
      for (const [predicate] of materialized) {
        if (helpers.get(predicate)!.some(rule => rule.body.some(atom => isTerm(atom.p) && helpers.has(atom.p.value) && !materialized.has(atom.p.value)))) {
          materialized.delete(predicate); removed = true;
        }
      }
    }
    let fresh = 0;
    const usedVariables = new Set([...forward, ...backward].flatMap(rule => [...rule.head, ...rule.body].flatMap(a => variables(a))));
    const expand = (body: Atom[], stack: string[] = []): Atom[][] => {
      let branches: Atom[][] = [[]];
      for (const atom of body) {
        const predicate = isTerm(atom.p) ? atom.p.value : '';
        const definitions = helpers.get(predicate);
        if (!definitions) { branches.forEach(branch => branch.push(atom)); continue; }
        if (materialized.has(predicate)) {
          branches.forEach(branch => branch.push({ ...atom, auxiliaryGraph: materialized.get(predicate) }));
          continue;
        }
        if (stack.includes(predicate)) throw new Error(`Recursive backward helper cannot be inlined: ${predicate}`);
        // Backward relations can also be satisfied by ordinary RDF facts or
        // by forward-derived heads. List/formula arguments cannot be RDF triples.
        const alternatives: Atom[][] = isTerm(atom.s) && isTerm(atom.o) ? [[atom]] : [];
        for (const definition of definitions) {
          let suffix: string;
          do { suffix = `__n3_helper_${++fresh}_`; } while (Array.from(usedVariables).some(name => name.startsWith(suffix)));
          const renamed = mapRule(definition, v => isVariable(v) ? { termType: 'Variable', value: suffix + v.value } as Term : v);
          [...renamed.body, ...renamed.head].flatMap(a => variables(a)).forEach(name => usedVariables.add(name));
          const substitutions = new Map<string, Value>();
          const bindings: Atom[] = [];
          if (!unify(renamed.head[0].s, atom.s, substitutions, bindings) || !unify(renamed.head[0].o, atom.o, substitutions, bindings)) continue;
          const substitute = (v: Value): Value => isVariable(v) && substitutions.has(v.value) ? substitute(substitutions.get(v.value)!) : v;
          alternatives.push(...expand([...renamed.body.map(a => mapAtom(a, substitute)), ...bindings], [...stack, predicate]));
        }
        branches = branches.flatMap(prefix => alternatives.map(alternative => [...prefix, ...alternative]));
        if (branches.length > 1024) throw new Error('Backward helper expansion exceeds 1024 branches; simplify input-bound helper alternatives.');
      }
      return branches;
    };
    // Backward clauses only execute when called. Eliminate unreachable helpers
    // after shape specialization, while checking every reachable branch below.
    const unused = backward.filter(rule => !reachable.has((rule.head[0]?.p as Term)?.value));
    if (unused.length) diagnostics.push({ severity: 'warning', message: `Omitted ${unused.length} unreachable backward helper clauses; all reachable clauses are translated.` });
    const helperRules = backward.filter(rule => materialized.has((rule.head[0]?.p as Term)?.value))
      .map(rule => ({ ...rule, auxiliaryGraph: materialized.get((rule.head[0].p as Term).value) }));
    for (const rule of [...helperRules, ...forward]) {
      try {
        const bodyBlanks = new Set(rule.body.flatMap(atom => variables(atom, true)).filter(v => v.startsWith('_')));
        const blankNames = new Map<string, string>();
        const replaceBlank = (v: Value): Value => {
          if (!isTerm(v) || v.termType !== 'BlankNode') return v;
          if (!blankNames.has(v.value)) {
            let name = `__n3_blank_${Array.from(v.value).map(c => c.codePointAt(0)!.toString(16)).join('_')}`;
            while (usedVariables.has(name)) name += '_';
            usedVariables.add(name); blankNames.set(v.value, name);
          }
          return { termType: 'Variable', value: blankNames.get(v.value)! } as Term;
        };
        for (const atom of rule.head) for (const v of values(atom)) if (isTerm(v) && v.termType === 'BlankNode' && !bodyBlanks.has('_' + v.value)) throw new Error('Existential blank nodes in rule heads cannot be translated without changing identity semantics.');
        const normalized = mapRule(rule, replaceBlank);
        for (const atom of normalized.head) if (isTerm(atom.p) && isBuiltin(atom.p.value)) throw new Error(`Built-ins in rule heads are not supported: ${atom.p.value}`);
        const branches = expand(normalized.body);
        const template = normalized.head.map(a => triple(a)).join('\n  ');
        if (!template) throw new Error('Empty rule heads are not supported.');
        const checks: string[] = [];
        const patterns = branches.map(branch => {
          const compiled = compileBody(branch, diagnostics, rule.index);
          checks.push(...compiled.checks.map(pattern => `CONSTRUCT { <urn:rdfjs:sparql:error> <urn:rdfjs:sparql:unsupportedSkolemInput> true } WHERE { ${pattern} }`));
          for (const variable of normalized.head.flatMap(a => variables(a))) if (!compiled.bound.has(variable)) throw new Error(`Head variable ?${variable} is not bound by the rule body.`);
          return `{\n    ${compiled.text.join('\n    ')}\n  }`;
        });
        rules.push({ rule: rule.index, ...(rule.auxiliaryGraph ? { graph: rule.auxiliaryGraph } : {}), ...(checks.length ? { checks: [...new Set(checks)] } : {}), query: `# N3 rule ${rule.index}\nCONSTRUCT {\n  ${template}\n}\nWHERE {\n  ${patterns.length ? patterns.join('\n  UNION\n  ') : 'FILTER(false)'}\n}\n` });
      } catch (error) { diagnostics.push({ severity: 'error', rule: rule.index, message: errorMessage(error) }); }
    }
    // Static lists remain RDF lists. Reject variables and executable predicates among facts.
    const facts = seeds.filter(q => {
      if (q.predicate.value !== LOG + 'memoize') return true;
      if (q.object.termType !== 'Literal' || q.object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#boolean' || !['true', '1', 'false', '0'].includes(q.object.value)) throw new Error('log:memoize requires a boolean optimization hint.');
      return false;
    });
    if (facts.length !== seeds.length) diagnostics.push({ severity: 'warning', builtin: LOG + 'memoize', message: 'log:memoize is an optimization hint; SPARQL evaluates helpers without memoization.' });
    for (const q of facts) {
      if ((q.subject as Term).termType === 'Literal') throw new Error('Literal-subject background facts are generalized RDF and cannot be materialized by SPARQL. Use an RDF/JS-compatible runtime.');
      if ([q.subject, q.predicate, q.object].some(t => t.termType === 'Variable')) throw new Error('Variables in top-level runtime facts are unsupported.');
      if (isBuiltin(q.predicate.value)) throw new Error(`Executable built-in outside a rule: ${q.predicate.value}`);
    }
    const seedQuery = facts.length ? `CONSTRUCT {\n  ${facts.map(q => `${render(q.subject)} ${render(q.predicate)} ${render(q.object)} .`).join('\n  ')}\n} WHERE {}\n` : null;
    return { program: diagnostics.some(d => d.severity === 'error') ? null : { seedQuery, rules, ...(materialized.size ? { auxiliaryGraphs: Array.from(materialized.values()) } : {}) }, diagnostics };
  } catch (error) { return { program: null, diagnostics: [...diagnostics, { severity: 'error', message: errorMessage(error) }] }; }
}

function compileBody(atoms: Atom[], diagnostics: N3SparqlDiagnostic[], rule: number, validateOnly = false, outer = new Set<string>()): { text: string[]; bound: Set<string>; checks: string[] } {
  const text: string[] = [], checks: string[] = [], bound = new Set<string>(outer), pending: Atom[] = [];
  for (const atom of atoms) {
    if (isTerm(atom.p) && isBuiltin(atom.p.value)) pending.push(atom);
    else {
      const pattern = triple(atom);
      text.push(atom.auxiliaryGraph ? `{ { ${pattern} } UNION { GRAPH <${atom.auxiliaryGraph}> { ${pattern} } } }` : pattern);
      variables(atom).forEach(v => bound.add(v));
    }
  }
  if (validateOnly) atoms.flatMap(a => variables(a)).forEach(v => bound.add(v));
  while (pending.length) {
    let progress = false;
    for (let i = 0; i < pending.length; i++) {
      const atom = pending[i], predicate = (atom.p as Term).value;
      const expression = builtin(atom, bound);
      if (!expression) continue;
      if (expression.check) checks.push(`${text.join(' ')} FILTER (${expression.check})`);
      if (expression.warning && !diagnostics.some(d => d.rule === rule && d.builtin === predicate)) diagnostics.push({ severity: 'warning', rule, builtin: predicate, message: expression.warning });
      text.push(expression.text);
      if (expression.bind) bound.add(expression.bind);
      pending.splice(i--, 1); progress = true;
    }
    if (!progress) throw new Error(`Unbound inputs or unsupported binding direction for built-in ${render(pending[0].p)}.`);
  }
  return { text, bound, checks };
}
function builtin(atom: Atom, bound: Set<string>): { text: string; bind?: string; warning?: string; check?: string } | undefined {
  const p = (atom.p as Term).value, s = atom.s, o = atom.o;
  const ready = (v: Value) => valueVariables(v).every(x => bound.has(x));
  const filter = (expression: string) => ({ text: `FILTER (${expression})` });
  const assign = (expression: string) => isVariable(o) && !bound.has(o.value)
    ? { text: `BIND (${expression} AS ${render(o)}) FILTER (BOUND(${render(o)}))`, bind: o.value } : ready(o) ? filter(`${expression} = ${render(o)}`) : undefined;
  const list = (n?: number): Value[] => {
    if (!('kind' in s) || s.kind !== 'list' || (n !== undefined && s.items.length !== n) || !s.items.length) throw new Error(`Built-in ${p} requires ${n ?? 'a nonempty list of'} arguments.`);
    return s.items;
  };
  const arithmetic: Record<string, string> = { sum: '+', product: '*', difference: '-', quotient: '/' };
  const unary: Record<string, string> = { absoluteValue: 'ABS', rounded: 'ROUND', floor: 'FLOOR', ceiling: 'CEIL', negation: '-' };
  const comparison: Record<string, string> = { greaterThan: '>', lessThan: '<', notGreaterThan: '<=', notLessThan: '>=', equalTo: '=', notEqualTo: '!=' };
  if (p.startsWith(MATH)) {
    const name = p.slice(MATH.length);
    if (arithmetic[name]) { const args = list(['difference', 'quotient'].includes(name) ? 2 : undefined); return ready(s) ? assign(`(${args.map(render).join(` ${arithmetic[name]} `)})`) : undefined; }
    if (unary[name]) {
      const expression = name === 'negation' ? `(-${render(s)})` : `${unary[name]}(${render(s)})`;
      // N3 math:rounded produces an integer, whereas SPARQL ROUND preserves
      // its argument's numeric datatype. Keep the N3 result datatype here.
      return ready(s) ? assign(name === 'rounded' ? `<http://www.w3.org/2001/XMLSchema#integer>(${expression})` : expression) : undefined;
    }
    if (comparison[name]) return ready(s) && ready(o) ? filter(`${render(s)} ${comparison[name]} ${render(o)}`) : undefined;
  }
  if (p === LOG + 'equalTo' && ready(s) && isVariable(o) && !ready(o)) return assign(render(s));
  if (p === LOG + 'equalTo' && ready(o) && isVariable(s) && !ready(s)) return { text: `BIND (${render(o)} AS ${render(s)})`, bind: s.value };
  if (p === LOG + 'equalTo' || p === LOG + 'notEqualTo') return ready(s) && ready(o) ? filter(`${p.endsWith('notEqualTo') ? '!' : ''}sameTerm(${render(s)}, ${render(o)})`) : undefined;
  if (p === LOG + 'dtlit') {
    const args = list(2), lexical = render(args[0]), datatype = render(args[1]);
    return ready(s) ? assign(`IF(isLiteral(${lexical}) && DATATYPE(${lexical}) = <http://www.w3.org/2001/XMLSchema#string> && isIRI(${datatype}), STRDT(STR(${lexical}), ${datatype}), (1 / 0))`) : undefined;
  }
  if (p === LOG + 'skolem') {
    if (!ready(s)) return undefined;
    const expression = assign(`IRI(CONCAT("urn:rdfjs:sparql:skolem:", SHA256(${skolemKey(s)})))`);
    const argumentsToCheck = valueVariables(s);
    return expression && { ...expression, ...(argumentsToCheck.length ? { check: argumentsToCheck.map(v => `isBlank(?${v})`).join(' || ') } : {}), warning: 'log:skolem emits deterministic SHA256 IRIs for named nodes and literals; blank-node arguments cause an execution error. Generated IRIs differ from Eyeling’s allocation scheme.' };
  }
  if (p === LIST + 'member' && isTerm(s)) {
    // RDF lists are already represented by rdf:first/rdf:rest in the dataset.
    if (!ready(s)) return undefined;
    if (!isTerm(o)) throw new Error('list:member requires an RDF term as its member.');
    return { text: `${render(s)} <${RDF}rest>*/<${RDF}first> ${render(o)} .`, ...isVariable(o) ? { bind: o.value } : {} };
  }
  if (p === LOG + 'notIncludes' || p === LOG + 'includes') {
    if (!('kind' in o) || o.kind !== 'formula' || !isTerm(s) || !((s.termType === 'BlankNode') || (s.termType === 'Variable' && !bound.has(s.value)) || (s.termType === 'Literal' && s.value === '1'))) throw new Error('log:includes/notIncludes only support 1 or an unbound current-store scope and a quoted graph pattern.');
    // Outer variables are correlated; local formula variables are existential.
    const pattern = compileBody(o.atoms, [], 0, false, bound);
    return { text: `FILTER ${p.endsWith('notIncludes') ? 'NOT ' : ''}EXISTS { ${pattern.text.join(' ')} }`, warning: 'Store-scoped includes/notIncludes uses eager source-order execution. Negation is not retracted; it is not general N3 formula containment.' };
  }
  if (p === DT + 'datatype') return ready(s) ? assign(`DATATYPE(${render(s)})`) : undefined;
  if (p === DT + 'lexicalForm') return ready(s) ? assign(`IF(isLiteral(${render(s)}), STR(${render(s)}), (1 / 0))`) : undefined;
  if (p === DT + 'sameValueAs' || p === DT + 'differentValueFrom') return ready(s) && ready(o)
    ? filter(`isLiteral(${render(s)}) && isLiteral(${render(o)}) && (${render(s)} ${p.endsWith('sameValueAs') ? '=' : '!='} ${render(o)})`) : undefined;
  if (p === STRING + 'concatenation') { const args = list(); return ready(s) ? assign(`CONCAT(${args.map(v => `STR(${render(v)})`).join(', ')})`) : undefined; }
  if (p === STRING + 'scrape') {
    const args = list(2);
    if (!isTerm(args[1]) || args[1].termType !== 'Literal') throw new Error('string:scrape requires a constant regex with a capturing group.');
    if (new RegExp(`(?:${args[1].value})|`).exec('')!.length < 2) throw new Error('string:scrape requires a capturing group.');
    if (!ready(s)) return undefined;
    const text = `STR(${render(args[0])})`, pattern = `STR(${render(args[1])})`;
    return assign(`IF(REGEX(${text}, ${pattern}), REPLACE(${text}, CONCAT(${JSON.stringify('^[\\s\\S]*?(?:')}, ${pattern}, ${JSON.stringify(')[\\s\\S]*$')}), "$1"), (1 / 0))`);
  }
  const strings: Record<string, string> = { contains: 'CONTAINS', startsWith: 'STRSTARTS', endsWith: 'STRENDS', matches: 'REGEX' };
  if (p.startsWith(STRING) && strings[p.slice(STRING.length)]) return ready(s) && ready(o) ? filter(`${strings[p.slice(STRING.length)]}(STR(${render(s)}), STR(${render(o)}))`) : undefined;
  throw new Error(`Unsupported N3 built-in: ${p}`);
}
function isBuiltin(p: string): boolean { return [MATH, LOG, STRING, DT, 'http://www.w3.org/2000/10/swap/list#', 'http://www.w3.org/2000/10/swap/time#', 'http://www.w3.org/2000/10/swap/crypto#', 'http://www.w3.org/2000/10/swap/os#'].some(ns => p.startsWith(ns)); }
function isTerm(v: Value): v is Term { return 'termType' in v; }
function isVariable(v: Value): v is Term { return isTerm(v) && v.termType === 'Variable'; }
function render(v: Value): string {
  if (!isTerm(v)) throw new Error('Lists and quoted formulas are supported only as built-in/helper arguments.');
  if (v.termType === 'Variable') return `?${v.value}`;
  if (v.termType === 'BlankNode') return `_:${v.value}`;
  if (v.termType === 'NamedNode') {
    if (/[<>"{}|^`\\\u0000-\u0020]/u.test(v.value)) throw new Error(`Invalid SPARQL IRI: ${v.value}`);
    return `<${v.value}>`;
  }
  if (v.termType === 'Literal') return JSON.stringify(v.value) + (v.language ? `@${v.language}` : `^^<${v.datatype.value}>`);
  throw new Error(`Unsupported N3 term: ${v.termType}`);
}
function triple(a: Atom): string {
  if (isTerm(a.s) && a.s.termType === 'Literal') throw new Error('Literal subjects are outside the supported RDF/SPARQL subset.');
  if (isTerm(a.p) && !['NamedNode', 'Variable'].includes(a.p.termType)) throw new Error('Triple predicates must be IRIs or variables.');
  return `${render(a.s)} ${render(a.p)} ${render(a.o)} .`;
}
function values(a: Atom): Value[] { return [a.s, a.p, a.o]; }
function valueVariables(v: Value, blanks = false): string[] {
  if (isTerm(v)) return v.termType === 'Variable' ? [v.value] : blanks && v.termType === 'BlankNode' ? ['_' + v.value] : [];
  return v.kind === 'list' ? v.items.flatMap(x => valueVariables(x, blanks)) : v.atoms.flatMap(a => variables(a, blanks));
}
function variables(a: Atom, blanks = false): string[] { return values(a).flatMap(v => valueVariables(v, blanks)); }
function mapValue(v: Value, f: (v: Value) => Value): Value {
  const result = f(v);
  if (isTerm(result)) return result;
  return result.kind === 'list' ? { kind: 'list', items: result.items.map(x => mapValue(x, f)) } : { kind: 'formula', atoms: result.atoms.map(a => mapAtom(a, f)) };
}
function mapAtom(a: Atom, f: (v: Value) => Value): Atom { return { ...a, s: mapValue(a.s, f), p: mapValue(a.p, f), o: mapValue(a.o, f) }; }
function mapRule(r: Rule, f: (v: Value) => Value): Rule { return { ...r, body: r.body.map(a => mapAtom(a, f)), head: r.head.map(a => mapAtom(a, f)) }; }
function unify(pattern: Value, actual: Value, substitutions: Map<string, Value>, bindings: Atom[]): boolean {
  if (isVariable(pattern)) {
    const previous = substitutions.get(pattern.value);
    if (!previous) { substitutions.set(pattern.value, actual); return true; }
    bindings.push({ s: previous, p: { termType: 'NamedNode', value: LOG + 'equalTo' } as Term, o: actual });
    return true;
  }
  if (isVariable(actual) && isTerm(pattern)) {
    bindings.push({ s: pattern, p: { termType: 'NamedNode', value: LOG + 'equalTo' } as Term, o: actual });
    return true;
  }
  if (isTerm(pattern) && isTerm(actual)) return pattern.equals(actual);
  if (!isTerm(pattern) && !isTerm(actual) && pattern.kind === 'list' && actual.kind === 'list') return pattern.items.length === actual.items.length && pattern.items.every((x, i) => unify(x, actual.items[i], substitutions, bindings));
  return false;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Length-delimited, typed encoding prevents tuple/lexical/datatype collisions.
 * Lists preserve ordering and nesting; quoted graph terms are not supported.
 */
function skolemKey(value: Value): string {
  if (!isTerm(value)) {
    if (value.kind !== 'list') throw new Error('log:skolem does not support quoted formulas.');
    return `CONCAT("[", ${value.items.map(skolemKey).join(', ') || '""'}, "]")`;
  }
  const term = render(value);
  const segment = (expression: string) => `CONCAT(STR(STRLEN(${expression})), ":", ${expression})`;
  if (value.termType === 'BlankNode') throw new Error('log:skolem requires RDF terms bound by graph patterns, not anonymous scope nodes.');
  // STR on blank nodes is not defined by SPARQL 1.1. Fail that solution rather
  // than creating a fresh identity on every iteration.
  return `IF(isIRI(${term}), CONCAT("I", ${segment(`STR(${term})`)}), IF(isLiteral(${term}), CONCAT("L", ${segment(`STR(${term})`)}, ${segment(`STR(DATATYPE(${term}))`)}, ${segment(`LANG(${term})`)}), (1 / 0)))`;
}

export type SparqlQueryExecutor = (query: string, dataset: readonly Quad[]) => Promise<Iterable<Quad>>;
export interface RdfjsSparqlEngine {
  queryQuads(query: string, context: { sources: any[]; baseIRI?: string }): Promise<{ toArray(): Promise<Quad[]> }>;
}
/** Adapter for Comunica's RDF/JS query engine. Undo its documented source-scoped
 * blank-node wrapping before reinserting results, preserving message identities.
 * The query engine is supplied by the caller; the library does not depend on Comunica.
 */
export function createRdfjsSparqlExecutor(engine: RdfjsSparqlEngine, options: { baseIRI?: string } = {}): SparqlQueryExecutor {
  const { Store, DataFactory } = require('n3');
  return async (query, dataset) => {
    const blanks = new Map<string, Term>();
    for (const q of dataset) for (const t of [q.subject, q.object]) if (t.termType === 'BlankNode') blanks.set(`bc_0_${t.value}`, t);
    const result = await (await engine.queryQuads(query, { sources: [new Store(dataset)], ...options })).toArray();
    const restore = (t: Term) => t.termType === 'BlankNode' && 'skolemized' in t ? blanks.get(t.value) ?? t : t;
    return result.map(q => DataFactory.quad(restore(q.subject), q.predicate, restore(q.object), q.graph));
  };
}
export interface SparqlRuntimeExecutionOptions { maxRounds?: number; maxFacts?: number }
export interface SparqlRuntimeExecutionResult { closure: Quad[]; derived: Quad[]; rounds: number; output: Quad[] }
/** Execute a translated runtime with any SPARQL 1.1 CONSTRUCT engine, e.g. Comunica.
 * The optional projection runs on heads, or on the closure when requested by the program.
 */
export async function executeSparqlRuntime(program: SparqlRuntimeProgram, input: Iterable<Quad>, executeQuery: SparqlQueryExecutor,
  options: SparqlRuntimeExecutionOptions & { outputQuery?: string } = {}): Promise<SparqlRuntimeExecutionResult> {
  const closure = new Map<string, Quad>(), derived = new Map<string, Quad>();
  const helperGraphs = new Set(program.auxiliaryGraphs ?? []);
  const key = (q: Quad) => JSON.stringify([q.subject, q.predicate, q.object, q.graph].map(t => t.termType === 'Literal' ? [t.termType, t.value, t.language, t.datatype.value] : [t.termType, t.value]));
  const maxRounds = options.maxRounds ?? 100, maxFacts = options.maxFacts ?? 100000;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || !Number.isSafeInteger(maxFacts) || maxFacts < 1) throw new Error('Runtime limits must be positive safe integers.');
  const add = (quads: Iterable<Quad>, heads: boolean, allowHelpers = false) => {
    let changed = false;
    for (const q of quads) {
      const helper = q.graph.termType === 'NamedNode' && helperGraphs.has(q.graph.value);
      if (q.graph.termType !== 'DefaultGraph' && !(allowHelpers && helper)) throw new Error('SPARQL runtime execution requires default-graph triples; flatten each message first.');
      const id = key(q); if (heads && !helper) derived.set(id, q);
      if (!closure.has(id)) { closure.set(id, q); changed = true; }
      if (closure.size > maxFacts) throw new Error(`SPARQL runtime exceeded ${maxFacts} facts; no complete result is available.`);
    }
    return changed;
  };
  add(input, false);
  if (program.seedQuery) add(await executeQuery(program.seedQuery, []), false);
  for (let rounds = 1; rounds <= maxRounds; rounds++) {
    let changed = false;
    for (const rule of program.rules) {
      for (const check of rule.checks ?? []) {
        if (Array.from(await executeQuery(check, Array.from(closure.values()))).length) throw new Error(`N3 rule ${rule.rule}: log:skolem with blank-node arguments is unsupported; use named identifiers. No complete result is available.`);
      }
      let result = await executeQuery(rule.query, Array.from(closure.values()));
      if (rule.graph) {
        if (!helperGraphs.has(rule.graph)) throw new Error(`Unknown private helper graph: ${rule.graph}`);
        const { DataFactory } = require('n3');
        result = Array.from(result, q => DataFactory.quad(q.subject, q.predicate, q.object, DataFactory.namedNode(rule.graph)));
      }
      if (add(result, true, true)) changed = true;
    }
    if (!changed) {
      const heads = Array.from(derived.values());
      const publicClosure = Array.from(closure.values()).filter(q => q.graph.termType === 'DefaultGraph');
      const projectionInput = program.projectionSource === 'closure' ? publicClosure : heads;
      const output = options.outputQuery ? Array.from(new Map(Array.from(await executeQuery(options.outputQuery, projectionInput), q => [key(q), q])).values()) : heads;
      return { closure: publicClosure, derived: heads, rounds, output };
    }
  }
  throw new Error(`SPARQL runtime did not converge within ${maxRounds} rounds; no complete result is available.`);
}
