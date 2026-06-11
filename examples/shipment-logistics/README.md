# Shipment logistics example

This OWL 2 RL example exercises a broader set of rule features than the transit fleet example.

## Files

- `ontology.n3` — background ontology.
- `input.trig` — input RDF data.
- `expected-selected-output.n3` — selected expected entailments.
- `run.ts` — example runner.

## Covered OWL 2 RL features

The ontology and input exercise selected consequences for:

- `owl:equivalentClass`
- `owl:equivalentProperty`
- `owl:inverseOf`
- `owl:SymmetricProperty`
- `owl:TransitiveProperty`
- `owl:FunctionalProperty`
- `owl:InverseFunctionalProperty`
- `owl:hasValue`
- `owl:someValuesFrom`
- `owl:allValuesFrom`

## Run

From the repository root:

```bash
npm run example:shipment-logistics
```

The runner asserts that all selected expected entailments are present in the closure, then prints only that selected subset so the fixture stays readable.

## Check

```bash
npm run test:shipment-logistics
```
