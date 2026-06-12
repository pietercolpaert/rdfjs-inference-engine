# OWL 2 RL performance harness

This folder contains an extensible performance harness for comparing `rdfjs-inference-engine` against other OWL 2 RL-capable reasoners that are available on the local machine.

The workload mix is MobiBench-inspired: it includes small synthetic rule-family cases and larger project regression cases. The harness does not install external reasoners automatically; optional competitors are detected and skipped when unavailable.

## Run

```sh
npm run perf
```

Useful options:

```sh
npm run perf -- --list
npm run perf -- --case=marc-list-messages --iterations=5 --warmup=2
npm run perf -- --reasoner=rdfjs-inference-engine,python-owlrl --json
npm run perf -- --csv > .cache/perf/results.csv
```

## Built-in reasoners

- `rdfjs-inference-engine`: the in-process Eyeling-generated runtime used by this package.
- `python-owlrl`: optional comparison with RDFLib + `owlrl`; requires `python3`, `rdflib`, and `owlrl` on `PATH`/`PYTHONPATH`.

Install the Python comparison dependencies with:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r perf/requirements.txt
```

The harness uses `PERF_PYTHON` when set, otherwise `.venv/bin/python` when it exists, otherwise `python3`.

## External reasoner commands

Additional CLI reasoners can be plugged in through `PERF_EXTERNAL_REASONERS`. The value is a JSON array of objects with `id`, optional `label`, and `command` fields. The command is executed by the shell and may use these placeholders:

- `{input}`: merged ontology + data graph serialized in N3/Turtle syntax.
- `{rules}`: this repository's OWL 2 RL N3 rules file.
- `{output}`: a suggested output file path in `.cache/perf/`.

Example:

```sh
PERF_EXTERNAL_REASONERS='[
  {"id":"my-reasoner","label":"My OWL RL CLI","command":"my-owlrl --input {input} --output {output}"}
]' npm run perf -- --reasoner=my-reasoner
```

This is intended for local comparisons with tools such as Jena-based scripts, RDFox scripts, GraphDB command-line exports, or custom wrappers. Because these tools expose different interfaces and closure semantics, the harness records timing and best-effort output counts, but it does not treat all output sizes as semantically equivalent.

## Notes on interpretation

- Native timings separate ontology `load` time from data `infer` time.
- External command timings include process startup and whatever parsing/loading the external tool performs. Some external adapters can report `parseMs` separately when their API exposes it.
- `outputQuads` is the number of emitted/materialized quads reported by the reasoner adapter. `closureQuads` is the adapter's best available closure size.
- Benchmarks are not correctness tests. Keep running the normal test suite for conformance and regression checks.
