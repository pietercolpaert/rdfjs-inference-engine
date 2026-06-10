# OWL 2 RL stream enrichment with Eyeling and N3

This repository demonstrates a pattern for doing **OWL 2 RL materialization at ingest time** with [Eyeling](https://github.com/eyereasoner/eyeling) and Notation3 rules.

The core idea is:

1. keep an OWL 2 RL ruleset as static background knowledge;
2. load your domain ontology as background knowledge;
3. load project-specific N3 rules that interpret each incoming RDF Message;
4. process an RDF Message Log one message at a time;
5. emit the triples that can be derived for each message.

This is useful when a service receives RDF Messages, enriches them immediately, and stores or publishes the materialized triples so downstream systems can query ordinary RDF without running OWL reasoning themselves.

## Repository layout

```text
.
├── README.md
├── rules/
│   ├── owl2rl-eyeling.n3       # OWL 2 RL/RDF materialization rules for Eyeling
│   ├── stream-enrichment.n3    # Message projection + application-specific rules
│   └── example-output.n3       # log:query output filter for the example
├── ontologies/
│   └── transit.n3              # Small demo ontology
├── examples/
│   ├── input/
│   │   └── messages.trig       # RDF Message Log example
│   └── expected-output.nt      # Expected command-line output
└── scripts/
    └── run-example.sh
```

## Requirements

Use the latest Eyeling version that includes the datatype builtins added after issue `eyereasoner/eyeling#18`.

The example can be run without installing Eyeling globally:

```bash
npx --yes eyeling --version
```

Eyeling requires Node.js. The upstream package currently documents Node.js `>=18`.

## How it works

### 1. OWL 2 RL rules as background knowledge

The file:

```text
rules/owl2rl-eyeling.n3
```

contains an N3 implementation-oriented OWL 2 RL/RDF ruleset for Eyeling. It includes rules for common OWL/RDFS entailments, including:

- `rdfs:subClassOf`
- `owl:equivalentClass`
- `rdfs:subPropertyOf`
- `owl:equivalentProperty`
- `rdfs:domain`
- `rdfs:range`
- inverse, symmetric, transitive, functional, and inverse-functional properties
- `owl:sameAs` / `owl:differentFrom`
- selected class expressions such as `owl:intersectionOf`, `owl:unionOf`, `owl:oneOf`, `owl:someValuesFrom`, `owl:allValuesFrom`, `owl:hasValue`, and cardinality rules
- property chains via recursive helper rules
- datatype rules using Eyeling's `dt:` builtins
- inconsistency diagnostics as `owlrl:Inconsistency` resources

The ruleset is meant to be loaded as background knowledge. In normal projects, do not edit it for application logic. Add application-specific rules in separate files.

### 2. Domain ontology as background knowledge

The example ontology is:

```text
ontologies/transit.n3
```

It defines a tiny transit model:

```n3
:ElectricBus rdfs:subClassOf :Bus .
:Bus rdfs:subClassOf :Vehicle .
:ObservedVehicle rdfs:subClassOf :Vehicle .
:operatedBy rdfs:domain :Vehicle ;
  rdfs:range :Operator .
:seatCount rdfs:range xsd:integer .
:reportedAt rdfs:range xsd:dateTime .
```

When a message says that `:bus-42 a :ElectricBus`, OWL 2 RL derives that `:bus-42 a :Bus` and `:bus-42 a :Vehicle`. When a message says that `:bus-42 :operatedBy :operator-7`, OWL 2 RL derives that `:operator-7 a :Operator`.

### 3. RDF Messages are projected into the reasoning scope

Eyeling supports RDF Message Logs under RDF compatibility mode. A log starts with:

```trig
VERSION "1.2-messages"
```

and uses `MESSAGE` delimiters between messages.

Eyeling exposes those parser-level message boundaries through the `eymsg:` replay vocabulary. The project-specific rule file:

```text
rules/stream-enrichment.n3
```

contains this bridge rule:

```n3
{
  ?Envelope a eymsg:MessageEnvelope ;
    eymsg:payloadKind eymsg:nonEmpty ;
    eymsg:payloadGraph ?Payload .
  ?Payload log:nameOf ?PayloadContext .
  ?PayloadContext log:includes { ?s ?p ?o } .
} => {
  ?s ?p ?o .
} .
```

That rule says: for the current non-empty RDF Message, take each payload triple and make it available to the ordinary N3/OWL 2 RL reasoning scope.

### 4. Application rules interpret the message

The same file contains an application rule:

```n3
{
  ?event a :VehicleObservation ;
    :observedVehicle ?vehicle ;
    :observedAt ?stop .
} => {
  ?vehicle a :ObservedVehicle ;
    :seenAt ?stop .
} .
```

So a message-level observation event becomes normal RDF facts about the observed vehicle. The OWL 2 RL rules can then derive superclass, domain, range, equality, datatype, and other consequences.

## Run the example

From the repository root:

```bash
npx --yes eyeling --rdf --stream-messages \
  rules/owl2rl-eyeling.n3 \
  ontologies/transit.n3 \
  rules/stream-enrichment.n3 \
  rules/example-output.n3 \
  examples/input/messages.trig
```

or:

```bash
./scripts/run-example.sh
```

Expected output:

```ntriples
<https://example.org/transit#bus-42> a <https://example.org/transit#Bus> .
<https://example.org/transit#bus-42> a <https://example.org/transit#Vehicle> .
<https://example.org/transit#bus-42> <https://example.org/transit#operatedBy> <https://example.org/transit#operator-7> .
<https://example.org/transit#operator-7> a <https://example.org/transit#Operator> .
<https://example.org/transit#bus-42> a <https://example.org/transit#Vehicle> .
<https://example.org/transit#bus-42> a <https://example.org/transit#ObservedVehicle> .
<https://example.org/transit#bus-42> <https://example.org/transit#seenAt> <https://example.org/transit#stop-12> .
```

The duplicate `:bus-42 a :Vehicle` is expected in this command because `--stream-messages` processes messages one at a time. Message 1 derives `:Vehicle` through `:ElectricBus -> :Bus -> :Vehicle`; message 2 derives it again through `:ObservedVehicle -> :Vehicle`.

To check the example mechanically:

```bash
./scripts/run-example.sh > /tmp/owl2rl-example-output.nt
diff -u examples/expected-output.nt /tmp/owl2rl-example-output.nt
```

## Why `rules/example-output.n3` exists

Eyeling normally prints newly derived triples. With a full OWL 2 RL ruleset, that can include many schema-level consequences such as reflexive equality, subclass closure, helper triples, datatype meta-triples, and inconsistency diagnostics.

The file:

```text
rules/example-output.n3
```

uses `log:query` to keep the example output focused on the application-level materialization. In a production project, you have three common options:

1. emit all newly derived triples and filter downstream;
2. add project-specific `log:query` rules for the triples you want to publish;
3. call Eyeling from JavaScript and filter the closure programmatically.

## Using this pattern in a project

A typical ingest-time architecture looks like this:

```text
RDF Message stream
  -> Eyeling with OWL 2 RL rules + ontology + stream rules
  -> derived triples
  -> deduplication / validation / persistence
  -> SPARQL endpoint, event bus, cache, or materialized RDF store
```

Recommended project structure:

```text
rules/
  owl2rl-eyeling.n3          # keep vendored and versioned
  stream-enrichment.n3       # your message interpretation rules
  output.n3                  # optional log:query output selection
ontologies/
  domain.n3                  # your domain ontology
examples/
  input/*.trig               # RDF Message Logs
  expected-output/*.nt       # regression-test fixtures
```

For server use, keep the OWL 2 RL ruleset and domain ontology stable and append one incoming message or message window at a time. For high-throughput pipelines, deduplicate emitted triples outside the reasoner before storing or republishing them.

## Datatype reasoning

The current ruleset uses Eyeling's `dt:` builtins:

```n3
@prefix dt: <https://eyereasoner.github.io/eyeling/datatype#> .
```

These allow the ruleset to express OWL 2 RL datatype rules declaratively:

- `dt:datatype`
- `dt:lexicalForm`
- `dt:language`
- `dt:validForDatatype`
- `dt:invalidForDatatype`
- `dt:sameValueAs`
- `dt:differentValueFrom`
- `dt:canonicalLiteral`

That means cases such as these can now be handled by builtins rather than ad-hoc numeric-only rules:

```n3
"01"^^xsd:integer dt:sameValueAs "1.0"^^xsd:decimal .
"true"^^xsd:boolean dt:sameValueAs "1"^^xsd:boolean .
"2026-06-10T12:00:00Z"^^xsd:dateTime dt:sameValueAs "2026-06-10T14:00:00+02:00"^^xsd:dateTime .
```

The ruleset also emits optional `owlrl:canonicalLiteral` helper triples. These are not OWL 2 RL entailments; they are useful for diagnostics and can be ignored or removed if unwanted.

## Inconsistency handling

The ruleset does not derive bare `false` for every OWL 2 RL inconsistency. Instead, it emits explicit diagnostic resources:

```n3
?err a owlrl:Inconsistency .
```

This is intentional for streaming systems. A single bad message can be logged, quarantined, or routed to a validation queue without stopping the entire stream processor.

If you want fail-fast behavior, add a project rule such as:

```n3
@prefix owlrl: <https://w3id.org/owlrl-n3#> .

{ ?err a owlrl:Inconsistency . } => { false } .
```

Eyeling exits with a non-zero inference-fuse code when `false` is derived.

## Remaining limitations

The datatype gap has been addressed by current Eyeling `dt:` builtins, but there are still practical and semantic boundaries:

1. **OWL 2 RL, not OWL 2 DL**  
   This is a rule-materialization approach for the OWL 2 RL profile. It does not implement OWL 2 DL tableau reasoning, arbitrary class satisfiability checking, or full non-Horn disjunctive search.

2. **Materialization can grow quickly**  
   `owl:sameAs`, transitive properties, subclass closure, and property chains can produce many triples. Use output filters and external deduplication in production.

3. **RDF Message state is an application policy**  
   `--stream-messages` processes messages one at a time. If later messages should build on facts from earlier messages, maintain an external state graph and feed that state back into Eyeling.

4. **Literal subjects may appear in datatype meta-triples**  
   OWL 2 RL datatype rules can produce generalized triples such as a literal having `rdf:type xsd:integer`. Eyeling can print them, but some RDF 1.1 stores may reject literal subjects. Use `log:query` filters if your sink requires ordinary RDF 1.1 triples only.

5. **This ruleset should still be tested against your data**  
   The file is implementation-oriented and should be treated as a vendored ruleset with regression tests. Do not assume that every edge case of every OWL 2 RL rule has been certified for your production data shape.

## References

- Eyeling repository: https://github.com/eyereasoner/eyeling
- Eyeling builtins catalog: https://github.com/eyereasoner/eyeling/blob/main/eyeling-builtins.ttl
- Eyeling issue for datatype builtins: https://github.com/eyereasoner/eyeling/issues/18
- OWL 2 RL profile: https://www.w3.org/TR/owl2-profiles/
- OWL 2 RL/RIF rules: https://www.w3.org/TR/rif-owl-rl/
- Notation3 Community Group specification: https://w3c-cg.github.io/N3/spec/
