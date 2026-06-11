# Transit RDF Messages example

This streaming example uses an RDF Messages log as input and emits inferred RDF Messages as output.

## Files

- `ontology.n3` — background transit vocabulary.
- `input.messages.trig` — RDF Messages input log.
- `expected-output.messages.nq` — expected inferred RDF Messages output.
- `run.ts` — example runner.

## Run

From the repository root:

```bash
npm run example:transit-messages
```

The runner processes the RDF Messages input message by message and writes inferred RDF Messages.

## Check

```bash
npm run test:transit-messages
```
