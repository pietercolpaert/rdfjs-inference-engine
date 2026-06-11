# OWL 2 RL + SKOS catalog example

This combined example loads the bundled OWL 2 RL and SKOS Core rule profiles together through the default rule loading behavior.

OWL/RDFS rules infer that catalog topics are SKOS concepts and map a domain-specific property to `skos:related`. SKOS rules then infer the symmetric related link, `skos:semanticRelation`, and SKOS domain/range typing.

## Files

- `ontology.n3` — background ontology and SKOS configuration.
- `input.trig` — input catalog RDF data.
- `expected-selected-output.n3` — selected expected entailments.
- `run.ts` — example runner.

## Run

From the repository root:

```bash
npm run example:owl-skos-catalog
```

## Check

```bash
npm run test:owl-skos-catalog
```
