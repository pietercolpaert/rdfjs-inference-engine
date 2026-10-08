import type { Quad } from '@rdfjs/types';
import type { PropertyShapePlan, ShapePlan } from './shacl-shape-planning';

const QUDT = 'http://qudt.org/schema/qudt/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
export interface QudtConversionPlan {
  pattern: string;
  numericVariable: string;
  unitVariable: string;
  sourceUnits: string[];
  targetUnit: string;
}
export const isQudtProperty = (property: PropertyShapePlan, name: 'numericValue' | 'unit'): boolean =>
  property.path.type === 'predicate' && property.path.predicate === QUDT + name;

/** Embed a finite QUDT affine conversion table into the query; execution needs no ontology fetch. */
export function planQudtConversion(ontology: Quad[], provider: ShapePlan, consumer: ShapePlan,
  root: string, suffix: number, iri: (value: string) => string): QudtConversionPlan | undefined {
  const numeric = consumer.propertyPlans.find(property => isQudtProperty(property, 'numericValue'));
  const unit = consumer.propertyPlans.find(property => isQudtProperty(property, 'unit'));
  if (!numeric || (!numeric.units.length && !unit?.hasValues.length)) return undefined;
  const targets = [...new Set([...numeric.units, ...unit?.hasValues ?? []])];
  if (targets.length !== 1) throw new Error('QUDT conversion requires exactly one consistent target unit.');
  if (!numeric.required || numeric.maxCount === 0 || !unit?.required || unit.hasValues.length !== 1 || unit.maxCount === 0) {
    throw new Error('QUDT conversion requires direct, required qudt:numericValue and qudt:unit properties, with sh:hasValue on the output unit.');
  }
  if (consumer.propertyPlans.filter(property => isQudtProperty(property, 'numericValue')).length !== 1
    || consumer.propertyPlans.filter(property => isQudtProperty(property, 'unit')).length !== 1) {
    throw new Error('QUDT conversion requires one numeric-value property and one unit property per shape.');
  }
  const sourceNumeric = provider.propertyPlans.find(property => isQudtProperty(property, 'numericValue'));
  const sourceUnit = provider.propertyPlans.find(property => isQudtProperty(property, 'unit'));
  if (!sourceNumeric || !sourceUnit) throw new Error('Provider must document direct qudt:numericValue and qudt:unit paths for QUDT conversion.');
  const declaredUnits = sourceUnit.hasValues.length ? sourceUnit.hasValues : sourceUnit.inValues;
  const sourceUnits = [...new Set(declaredUnits.length ? declaredUnits : sourceNumeric.units)]
    .filter(unit => !sourceNumeric.units.length || sourceNumeric.units.includes(unit));
  if (!sourceUnits.length) throw new Error('Provider must declare its source units using sh:in or sh:hasValue on qudt:unit, or sh:unit on qudt:numericValue.');
  const datatype = numeric.datatype ?? XSD + 'decimal';
  if (![XSD + 'decimal', XSD + 'double', XSD + 'float'].includes(datatype)) {
    throw new Error('Converted QUDT values support xsd:decimal, xsd:double, or xsd:float output.');
  }
  const target = unitMetadata(ontology, targets[0]);
  const sources = sourceUnits.map(source => {
    const metadata = unitMetadata(ontology, source);
    if (metadata.dimension !== target.dimension) throw new Error(`QUDT units have incompatible dimensions: ${source} and ${targets[0]}.`);
    return { unit: source, ...metadata };
  });
  const raw = `?qudtRaw${suffix}`, sourceUnitVariable = `?qudtSourceUnit${suffix}`;
  const multiplier = `?qudtMultiplier${suffix}`, offset = `?qudtOffset${suffix}`;
  const numericVariable = `?qudtValue${suffix}`, unitVariable = `?qudtUnit${suffix}`;
  const decimal = iri(XSD + 'decimal');
  const rows = sources.map(source => `(${iri(source.unit)} ${source.multiplier} ${source.offset})`).join(' ');
  return {
    pattern: `${root} ${iri(QUDT + 'numericValue')} ${raw} ; ${iri(QUDT + 'unit')} ${sourceUnitVariable} .\n`
      + `    VALUES (${sourceUnitVariable} ${multiplier} ${offset}) { ${rows} }\n`
      + `    FILTER (isNumeric(${raw}))\n`
      + `    BIND (${iri(datatype)}((${decimal}(${raw}) * ${multiplier} + ${offset} - ${target.offset}) / ${target.multiplier}) AS ${numericVariable})\n`
      + `    FILTER (BOUND(${numericVariable}))\n`
      + `    BIND (${iri(targets[0])} AS ${unitVariable})`,
    numericVariable, unitVariable, sourceUnits, targetUnit: targets[0],
  };
}

function unitMetadata(ontology: Quad[], unit: string): { dimension: string; multiplier: string; offset: string } {
  const values = (predicate: string) => ontology.filter(q => q.subject.termType === 'NamedNode' && q.subject.value === unit && q.predicate.value === predicate).map(q => q.object);
  const dimensions = values(QUDT + 'hasDimensionVector');
  if (dimensions.length !== 1 || dimensions[0].termType !== 'NamedNode') throw new Error(`QUDT unit needs one dimension vector: ${unit}.`);
  // Logarithmic and other non-affine units must not enter the affine kernel.
  if (values('http://www.w3.org/1999/02/22-rdf-syntax-ns#type').some(term => term.value === QUDT + 'LogarithmicUnit')
    || ontology.some(q => q.subject.value === unit && q.predicate.value === QUDT + 'conversionFunction')) {
    throw new Error(`Only direct QUDT units with affine conversion metadata are supported: ${unit}.`);
  }
  const number = (predicate: string, defaultValue?: string): string => {
    const terms = values(QUDT + predicate);
    if (!terms.length && defaultValue !== undefined) return defaultValue;
    if (terms.length !== 1 || terms[0].termType !== 'Literal' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(terms[0].value)
      || !Number.isFinite(Number(terms[0].value))) throw new Error(`QUDT unit needs a finite ${predicate}: ${unit}.`);
    const term = terms[0];
    if (!term.datatype.value.startsWith(XSD) || !['decimal', 'double', 'float', 'integer'].includes(term.datatype.value.slice(XSD.length))) {
      throw new Error(`QUDT ${predicate} must be a numeric RDF literal: ${unit}.`);
    }
    const value = /[eE]/.test(term.value) ? expandDecimal(term.value) : term.value.replace(/^\+/, '');
    // Decimal query constants retain decimal arithmetic even when metadata uses scientific notation.
    return `"${value}"^^<${XSD}decimal>`;
  };
  const multiplier = number('conversionMultiplier');
  if (values(QUDT + 'conversionMultiplier').some(term => Number(term.value) <= 0)) throw new Error(`QUDT conversion multiplier must be positive: ${unit}.`);
  return { dimension: dimensions[0].value, multiplier, offset: number('conversionOffset', '0.0') };
}

// Expand scientific metadata lexically, without rounding through a JavaScript float.
function expandDecimal(value: string): string {
  const [mantissa, exponentText] = value.toLowerCase().split('e');
  const exponent = Number(exponentText);
  if (Math.abs(exponent) > 1000) throw new Error('QUDT conversion exponent is too large.');
  const sign = mantissa.startsWith('-') ? '-' : '';
  const unsigned = mantissa.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = whole + fraction;
  const position = whole.length + exponent;
  return sign + (position <= 0 ? '0.' + '0'.repeat(-position) + digits
    : position >= digits.length ? digits + '0'.repeat(position - digits.length) + '.0'
      : digits.slice(0, position) + '.' + digits.slice(position));
}
