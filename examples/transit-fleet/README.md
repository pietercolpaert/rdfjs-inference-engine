# Transit fleet example

This is the smallest OWL 2 RL/RDFS example. It demonstrates subclass, domain, and range materialization for a tiny transit vocabulary.

## Files

- `ontology.n3` — background vocabulary.
- `input.messages.trig` — one-message RDF Message log.
- `shapes-in.n3` — accepted electric-bus input contract.
- `shapes-out.n3` — required vehicle and operator output contract.
- `expected-output.n3` — expected inferred triples.
- `run.ts` — example runner.

## Run

From the repository root:

```bash
./scripts/run-example.sh
# or:
npm run example:transit-fleet
```

The runner loads the background ontology with the default bundled rule profiles, generates `generated/transit-fleet-runtime.n3`, and then runs inference over `input.messages.trig`.

The input triples themselves are not returned; the output contains only newly derived triples.

Expected output:

```n3
@prefix : <https://example.org/transit#>.

:bus-42 a :Vehicle.
:operator-7 a :Operator.
:bus-42 a :Bus.
```

## Check

```bash
npm run test:transit-fleet
```
