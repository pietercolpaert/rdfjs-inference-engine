# Stateful materialization example

This RDF Messages example demonstrates why stream enrichment sometimes needs a materialized state graph instead of processing each message independently.

The ontology says that a `:Mother` is equivalent to the intersection of `:Female` and `:Parent`, and that the object of `:hasParent` is a `:Parent`. The input deliberately splits the evidence across two RDF Messages:

1. first message: `:alice a :Female`;
2. second message: `:bob :hasParent :alice`.

Without stateful materialization, the second message can infer only that `:alice a :Parent`; it cannot also infer `:alice a :Mother`, because the `:Female` assertion was in a previous message.

With `--stateful-materialization`, the runner stores each asserted message and each inferred delta in a local materialized state graph, then reasons over that state plus the next message. The second message can then infer that `:alice a :Mother`.

## Files

- `ontology.n3` — background family ontology.
- `input.messages.trig` — RDF Messages input log.
- `expected-stateless-output.messages.nq` — expected output without state.
- `expected-stateful-output.messages.nq` — expected output with stateful materialization.
- `run.ts` — example runner.

## Run

From the repository root, run the stateful version:

```bash
npm run example:stateful-materialization
```

To run the stateless version directly:

```bash
npm run build --silent
node dist/examples/stateful-materialization/run.js
```

## Check

Compare the stateless and stateful fixtures:

```bash
npm run test:stateful-materialization
```
