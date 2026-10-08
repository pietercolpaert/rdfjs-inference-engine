/** Editable N3 mapping profile. This is a SPARQL-compatible subset of the
 * engine's OWL and QUDT profiles. All mapping arithmetic lives in N3. */
export const defaultSparqlMappingRules = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix math: <http://www.w3.org/2000/10/swap/math#> .
@prefix log: <http://www.w3.org/2000/10/swap/log#> .
@prefix internal: <urn:rdfjs:sparql:> .

# Consumer unit declarations are output configuration, never source assumptions.
{ ?shape sh:property ?numericField, ?unitField.
  ?numericField sh:path qudt:numericValue.
  ?unitField sh:path qudt:unit; sh:hasValue ?unit.
} => { ?numericField sh:unit ?unit } .

# Ontology entailment. Chained mappings use fixed-point execution.
{ ?s rdf:type ?a. ?a rdfs:subClassOf ?b } => { ?s rdf:type ?b } .
{ ?s ?a ?o. ?a rdfs:subPropertyOf ?b } => { ?s ?b ?o } .
{ ?a owl:equivalentClass ?b } => { ?a rdfs:subClassOf ?b. ?b rdfs:subClassOf ?a } .
{ ?a owl:equivalentProperty ?b } => { ?a rdfs:subPropertyOf ?b. ?b rdfs:subPropertyOf ?a } .
{ ?a owl:inverseOf ?b. ?s ?a ?o } => { ?o ?b ?s } .
{ ?a owl:inverseOf ?b. ?s ?b ?o } => { ?o ?a ?s } .
{ ?s ?p ?o. ?p rdfs:domain ?c } => { ?s rdf:type ?c } .
{ ?s ?p ?o. ?p rdfs:range ?c } => { ?o rdf:type ?c } .

# Copy facts for identity fields. Do not leak raw quantity values into output.
{ ?s ?p ?o. ?p log:notEqualTo qudt:numericValue. ?p log:notEqualTo qudt:unit }
  => { ?s ?p ?o } .
{ ?s qudt:numericValue ?value. 1 log:notIncludes { ?field sh:unit ?unit } }
  => { ?s qudt:numericValue ?value } .
{ ?s qudt:unit ?unit. 1 log:notIncludes { ?field sh:unit ?target } }
  => { ?s qudt:unit ?unit } .

# Nonrecursive backward helper: absent offsets mean zero.
{ ?unit internal:offset ?offset } <= { ?unit qudt:conversionOffset ?offset } .
{ ?unit internal:offset 0.0 } <= {
  ?unit qudt:conversionMultiplier ?multiplier.
  1 log:notIncludes { ?unit qudt:conversionOffset ?offset }
} .

# Same affine arithmetic as the N3 QUDT profile:
# canonical = (source + sourceOffset) * sourceMultiplier
# target = canonical / targetMultiplier - targetOffset
{ ?shape sh:targetClass ?class; sh:property ?field.
  ?field sh:path qudt:numericValue; sh:unit ?targetUnit.
  ?s rdf:type ?class; qudt:numericValue ?source; qudt:unit ?sourceUnit.
  ?sourceUnit qudt:hasDimensionVector ?dimension; qudt:conversionMultiplier ?sourceMultiplier.
  ?targetUnit qudt:hasDimensionVector ?dimension; qudt:conversionMultiplier ?targetMultiplier.
  ?sourceUnit internal:offset ?sourceOffset.
  ?targetUnit internal:offset ?targetOffset.
  ?sourceMultiplier math:greaterThan 0.
  ?targetMultiplier math:greaterThan 0.
  1 log:notIncludes { ?sourceUnit rdf:type qudt:LogarithmicUnit } .
  1 log:notIncludes { ?targetUnit rdf:type qudt:LogarithmicUnit } .
  1 log:notIncludes { ?sourceUnit qudt:conversionMultiplier ?otherSourceMultiplier.
    ?otherSourceMultiplier math:notEqualTo ?sourceMultiplier } .
  1 log:notIncludes { ?targetUnit qudt:conversionMultiplier ?otherTargetMultiplier.
    ?otherTargetMultiplier math:notEqualTo ?targetMultiplier } .
  1 log:notIncludes { ?s internal:normalizedTo ?targetUnit } .
  (?source ?sourceOffset) math:sum ?shifted.
  (?shifted ?sourceMultiplier) math:product ?canonical.
  (?canonical ?targetMultiplier) math:quotient ?scaled.
  (?scaled ?targetOffset) math:difference ?target.
} => {
  ?s qudt:numericValue ?target; qudt:unit ?targetUnit; internal:normalizedTo ?targetUnit.
} .
`;
