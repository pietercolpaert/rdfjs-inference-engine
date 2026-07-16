# SKOS taxonomy example

This example materializes SKOS Core consequences for a small taxonomy.

## Files

- `ontology.n3` — background concept scheme.
- `input.messages.trig` — one-message RDF Message log.
- `shapes-in.n3` — accepted taxonomy input contract.
- `shapes-out.n3` — required expanded SKOS output contract.
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
