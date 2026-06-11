# SKOS taxonomy example

This example materializes SKOS Core consequences for a small taxonomy.

## Files

- `ontology.n3` — background concept scheme.
- `input.trig` — input SKOS data.
- `expected-selected-output.n3` — selected expected entailments.
- `run.ts` — example runner.

## Covered SKOS consequences

The example includes consequences such as:

- `skos:broaderTransitive`
- `skos:narrower`
- `skos:semanticRelation`
- `rdfs:label`
- `skos:note`
- concept-scheme top-concept links

## Run

From the repository root:

```bash
npm run example:skos-taxonomy
```

## Check

```bash
npm run test:skos-taxonomy
```
