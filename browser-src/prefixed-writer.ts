import type { BaseQuad, Quad, Term } from '@rdfjs/types';
import { prefixCcDefaults } from './prefix-cc';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const LOCAL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const BARE_LITERALS: Record<string, RegExp> = {
  [XSD + 'boolean']: /^(?:true|false)$/,
  [XSD + 'integer']: /^[+-]?\d+$/,
  [XSD + 'decimal']: /^[+-]?(?:\d+\.\d*|\.\d+)$/,
  [XSD + 'double']: /^[+-]?(?:\d+\.\d*|\.\d+|\d+)[Ee][+-]?\d+$/,
};
interface RdfWriter {
  addPrefixes(prefixes: Record<string, string>): void;
  addQuads(quads: Iterable<Quad>): void;
  addMessage(message: Iterable<Quad>, done?: (error?: Error | null) => void): void;
  end(done?: (error?: Error | null, output?: string) => void): void;
}
/** Offer source prefixes without declaring unused ones. Prefix.cc supplies
 * labels for other namespaces, just before the first batch that needs them.
 * Already emitted prefix bindings are immutable; conflicts receive aliases.
 */
export class PrefixedWriter {
  private readonly offered = new Map<string, string>();
  private readonly declared = new Map<string, string>(); // namespace -> label
  private readonly labels = new Map<string, string>(); // label -> namespace
  public constructor(private readonly writer: RdfWriter,
    private readonly table: Readonly<Record<string, string>> = prefixCcDefaults) {}

  public addPrefix(label: string, iri: string | { value: string }): void {
    const namespace = typeof iri === 'string' ? iri : iri.value;
    // Prefix declarations are syntax, so ignore labels/IRIs that cannot be serialized.
    if (!/^(?:[A-Za-z_][A-Za-z0-9_-]*)?$/.test(label) || !/^[a-z][a-z0-9+.-]*:/i.test(namespace)
      || /[<>"{}|^`\\\u0000-\u0020]/u.test(namespace)) return;
    this.offered.set(label, namespace);
  }
  public addPrefixes(prefixes: Record<string, string | { value: string }>): void {
    for (const [label, iri] of Object.entries(prefixes)) this.addPrefix(label, iri);
  }
  public addQuads(quads: Iterable<Quad>): void {
    const batch = Array.from(quads);
    this.declareFor(batch);
    this.writer.addQuads(batch);
  }
  public addMessage(message: Iterable<Quad>, done?: (error?: Error | null) => void): void {
    const batch = Array.from(message);
    this.declareFor(batch);
    this.writer.addMessage(batch, done);
  }
  public end(done?: (error?: Error | null, output?: string) => void): void { this.writer.end(done); }
  public get prefixes(): Record<string, string> { return Object.fromEntries(this.labels); }

  private declareFor(quads: Quad[]): void {
    const pending = new Map<string, string>();
    const collectIri = (iri: string) => {
      if ([...this.declared.keys(), ...pending.keys()].some(ns => compacts(iri, ns))) return;
      // Prefer the most specific source namespace; fall back to the registry.
      let candidate: [string, string] | undefined;
      for (const [label, namespace] of this.offered) if (compacts(iri, namespace)
        && (!candidate || namespace.length > candidate[0].length)) candidate = [namespace, label];
      if (!candidate) {
        const local = /[A-Za-z0-9_][A-Za-z0-9_-]*$/.exec(iri);
        if (!local) return;
        for (let end = iri.length - 1; end >= local.index; end--) {
          const namespace = iri.slice(0, end);
          // Registry entries may include local-name stems such as obo/GO_.
          const label = end === local.index || /[_-]/.test(iri[end - 1]) ? this.table[namespace] : undefined;
          if (label && compacts(iri, namespace)) { candidate = [namespace, label]; break; }
        }
      }
      if (!candidate) return;
      const [namespace, preferred] = candidate;
      let label = preferred, suffix = 2;
      // Reserve offered names even when they haven't appeared in the output yet.
      // A fallback must not steal a label the input assigned to another namespace.
      const taken = (name: string) => this.labels.has(name) || Array.from(pending.values()).includes(name)
        || (this.offered.has(name) && this.offered.get(name) !== namespace);
      while (taken(label)) label = (preferred || 'ns') + suffix++;
      pending.set(namespace, label);
    };
    const collectTerm = (term: Term) => {
      if (term.termType === 'NamedNode') collectIri(term.value);
      else if (term.termType === 'Literal') {
        const datatype = term.datatype.value;
        if (!term.language && datatype !== XSD + 'string' && !BARE_LITERALS[datatype]?.test(term.value)) collectIri(datatype);
      } else if (term.termType === 'Quad') collectQuad(term);
    };
    const collectQuad = (quad: BaseQuad) => {
      collectTerm(quad.subject);
      if (quad.predicate.value !== RDF_TYPE) collectTerm(quad.predicate);
      collectTerm(quad.object); collectTerm(quad.graph);
    };
    quads.forEach(collectQuad);
    if (!pending.size) return;
    for (const [namespace, label] of pending) { this.declared.set(namespace, label); this.labels.set(label, namespace); }
    this.writer.addPrefixes(Object.fromEntries(Array.from(pending, ([namespace, label]) => [label, namespace])));
  }
}
function compacts(iri: string, namespace: string): boolean { return iri.startsWith(namespace) && LOCAL_NAME.test(iri.slice(namespace.length)); }
