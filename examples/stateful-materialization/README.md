# Stateful materialization example

This RDF Messages example demonstrates why stream enrichment sometimes needs a materialized state graph instead of processing each message independently.

The ontology says that a `:Mother` is equivalent to the intersection of `:Female` and `:Parent`, and that the object of `:hasParent` is a `:Parent`. The input deliberately splits the evidence across two RDF Messages:

1. first message: `:alice a :Female`;
2. second message: `:bob :hasParent :alice`.

Without stateful materialization, the second message can infer only that `:alice a :Parent`; it cannot also infer `:alice a :Mother`, because the `:Female` assertion was in a previous message.

With `--stateful-materialization`, the runner uses Eyeling's named persistent fact store. Each message's asserted facts and inferred delta are persisted in that store, and the next message reasons over the stored state plus its new facts. The second message can then infer that `:alice a :Mother`.

The default storage path is `.cache/eyeling-stores`. The default storage name is derived from the current project path plus this example's ontology and input file, so different projects/datasets do not share one store. For repeatable example output, the store is cleared at the start of each run unless `--resume-storage` is passed.

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

Use an explicit storage name when you want to pin state to a project or dataset:

```bash
npm run build --silent
node dist/examples/stateful-materialization/run.js --stateful-materialization --storage-name my-project-my-dataset
```

Resume an existing store across process runs with:

```bash
node dist/examples/stateful-materialization/run.js --stateful-materialization --storage-name my-project-my-dataset --resume-storage
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
