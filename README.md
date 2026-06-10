# OWL 2 RL reasoning over RDF Message streams with Eyeling

This repository shows how to use Eyeling as a lightweight OWL 2 RL enrichment engine for RDF Message streams.

The core idea is:

1. load an OWL 2 RL ruleset as static background knowledge;
2. load domain ontologies and application-specific N3 rules as additional background knowledge;
3. process each incoming RDF Message as an atomic unit of RDF data;
4. emit the new triples that can be derived from that message and the background knowledge.

This makes it possible to add semantic enrichment to streaming RDF pipelines while keeping the reasoning rules inspectable and version-controlled.

## Files

Suggested repository layout:

```text
.
├── README.md
├── rules/
│   ├── owl2rl-eyeling-possible.n3
│   └── stream-interpretation.n3
├── ontologies/
│   └── domain.n3
├── examples/
│   ├── message-001.n3
│   └── message-001.expected.n3
└── test/
    └── ...
```

The important file is:

```text
rules/owl2rl-eyeling-possible.n3
```

It contains the OWL 2 RL/RDF rules that are currently expressible with Eyeling's documented built-ins. This file should be treated as static background knowledge: applications do not normally modify it. Instead, add project-specific rules in separate files such as `rules/stream-interpretation.n3`.

## Reasoning model

For each RDF Message, the reasoner receives the union of:

```text
OWL 2 RL rules
+ domain ontology
+ stream interpretation rules
+ current RDF Message
```

Eyeling then derives the triples that follow from that combined input.

A typical command-line invocation looks like this:

```bash
npx eyeling \
  rules/owl2rl-eyeling-possible.n3 \
  ontologies/domain.n3 \
  rules/stream-interpretation.n3 \
  examples/message-001.n3
```

By default, Eyeling prints newly derived triples rather than simply echoing the original input facts. This is useful for stream enrichment: the downstream consumer receives the inferred triples that the message makes available.

## Background OWL 2 RL rules

The OWL 2 RL ruleset is loaded as ordinary N3 background knowledge. It contains rules for common OWL/RDFS entailments, including:

* `rdfs:subClassOf`
* `owl:equivalentClass`
* `rdfs:subPropertyOf`
* `owl:equivalentProperty`
* `rdfs:domain`
* `rdfs:range`
* `owl:inverseOf`
* `owl:SymmetricProperty`
* `owl:TransitiveProperty`
* `owl:FunctionalProperty`
* `owl:InverseFunctionalProperty`
* `owl:sameAs`
* `owl:differentFrom`
* selected class-expression support such as intersections, unions, value restrictions, and cardinality rules where expressible
* recursive property-chain support
* inconsistency reporting through `owlrl:Inconsistency` resources

The ruleset intentionally does not try to implement all of OWL 2 DL. OWL 2 RL is the rule-oriented OWL profile. The goal here is scalable stream enrichment, not full DL satisfiability checking.

## Current datatype status

The current Eyeling-compatible ruleset contains partial datatype support.

Numeric value equality and inequality are handled where Eyeling's numeric math built-ins can compare literals, for example through `math:equalTo` and `math:notEqualTo`.

Full OWL 2 RL datatype reasoning is not yet implemented because it requires built-ins for:

* extracting a literal's datatype IRI;
* extracting a literal's lexical form;
* checking whether a literal is valid for a datatype;
* comparing literals by XSD value-space equality;
* comparing literals by XSD value-space inequality;
* canonicalizing literals.

Until those built-ins exist, the following are intentionally incomplete:

* boolean value equality, such as `"true"^^xsd:boolean` versus `"1"^^xsd:boolean`;
* date/time value equality across time zones;
* invalid lexical form detection;
* string-derived datatype value-space reasoning;
* binary and URI datatype value-space reasoning.

In practice, this is still useful for many RDF stream enrichment cases, but applications that depend on complete OWL 2 RL datatype semantics should treat this as a known limitation.

## Domain ontology example

The domain ontology should be loaded as background knowledge.

Example `ontologies/domain.n3`:

```n3
@prefix :     <https://example.org/demo#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

:Vehicle a owl:Class .
:Bus rdfs:subClassOf :Vehicle .
:ElectricBus rdfs:subClassOf :Bus .

:operatedBy rdfs:domain :Vehicle .
:operatedBy rdfs:range :Operator .

:hasPart a owl:TransitiveProperty .
```

Given an incoming message such as:

```n3
@prefix : <https://example.org/demo#> .

:bus-42 a :ElectricBus .
:bus-42 :operatedBy :operator-7 .
```

Eyeling can derive triples such as:

```n3
@prefix : <https://example.org/demo#> .

:bus-42 a :Bus .
:bus-42 a :Vehicle .
:operator-7 a :Operator .
```

## Stream interpretation rules

Application-specific stream rules should live outside the OWL 2 RL ruleset.

Example `rules/stream-interpretation.n3`:

```n3
@prefix :      <https://example.org/demo#> .
@prefix event: <https://example.org/event#> .

# Interpret a vehicle observation event as a statement that the observed asset
# was seen at the reported stop.
{
  ?event a event:VehicleObservation .
  ?event event:vehicle ?vehicle .
  ?event event:stop ?stop .
}
=>
{
  ?vehicle :seenAt ?stop .
} .

# Add a higher-level classification for vehicles that are observed in service.
{
  ?event a event:VehicleObservation .
  ?event event:vehicle ?vehicle .
}
=>
{
  ?vehicle a :ObservedVehicle .
} .
```

Given a message:

```n3
@prefix :      <https://example.org/demo#> .
@prefix event: <https://example.org/event#> .

:event-123 a event:VehicleObservation ;
  event:vehicle :bus-42 ;
  event:stop :stop-9 .
```

The stream rules can derive:

```n3
@prefix : <https://example.org/demo#> .

:bus-42 :seenAt :stop-9 .
:bus-42 a :ObservedVehicle .
```

The OWL 2 RL background rules can then continue from those derived triples. For example, if `:ObservedVehicle rdfs:subClassOf :Vehicle`, then `:bus-42 a :Vehicle` is also derivable.

## RDF Message envelope pattern

Some pipelines pass each message directly to the reasoner as RDF triples. In that case, no envelope rule is needed.

Other pipelines represent each message as an N3 quoted formula. In that case, add a small bridge rule that projects the message payload into the reasoning scope.

Example message envelope:

```n3
@prefix msg: <https://w3id.org/rdf-message#> .
@prefix :    <https://example.org/demo#> .

:message-001 a msg:Message ;
  msg:payload {
    :bus-42 a :ElectricBus .
    :bus-42 :operatedBy :operator-7 .
  } .
```

Example bridge rule:

```n3
@prefix msg: <https://w3id.org/rdf-message#> .
@prefix log: <http://www.w3.org/2000/10/swap/log#> .

{
  ?message msg:payload ?payload .
  ?payload log:includes { ?s ?p ?o } .
}
=>
{
  ?s ?p ?o .
} .
```

Use this pattern only when messages are represented as quoted formulae. If the message triples are already passed as normal input, projecting them again is unnecessary.

## Producing only new triples

There are two common modes.

### Stateless per-message enrichment

Each message is reasoned over independently with the same background knowledge:

```text
background + message-001 -> derived triples for message-001
background + message-002 -> derived triples for message-002
background + message-003 -> derived triples for message-003
```

This is simple and works well when each message is self-contained.

If the stream consumer must avoid re-emitting the same inferred triple twice, keep a set of emitted triples outside the reasoner and suppress duplicates there.

### Stateful enrichment

The application maintains a materialized state graph:

```text
state-000 + message-001 -> closure-001
state-001 + message-002 -> closure-002
state-002 + message-003 -> closure-003
```

After each message, update the state with the accepted derived triples. This allows later messages to build on facts derived from earlier messages.

This repository should keep that state-management policy outside the OWL 2 RL ruleset. The ruleset says what follows logically; the stream processor decides what to remember, expire, deduplicate, or publish.

## Inconsistency reporting

The ruleset does not derive logical `false`. Instead, inconsistency rules produce explicit diagnostic resources of type:

```n3
@prefix owlrl: <https://w3id.org/owlrl-n3#> .

owlrl:Inconsistency
```

This is deliberate. In a stream, one inconsistent message should usually be reportable without making the whole pipeline unusable.

A downstream processor can route these inconsistency reports to logs, metrics, alerts, quarantine queues, or validation feedback.

## Querying selected output

Eyeling supports `log:query` as an output-selection directive. Add a query when you want to restrict output to a specific shape.

For example, to output only derived vehicle observations:

```n3
@prefix :    <https://example.org/demo#> .
@prefix log: <http://www.w3.org/2000/10/swap/log#> .

{
  ?vehicle :seenAt ?stop .
}
log:query
{
  ?vehicle :seenAt ?stop .
} .
```

For general enrichment, it is usually better to let Eyeling emit all derived triples and filter in the application layer.

## JavaScript integration sketch

A stream processor can keep the rules and ontology loaded as strings and append one RDF Message at a time.

```js
const fs = require('node:fs');
const { reason } = require('eyeling');

const background = [
  fs.readFileSync('rules/owl2rl-eyeling-possible.n3', 'utf8'),
  fs.readFileSync('ontologies/domain.n3', 'utf8'),
  fs.readFileSync('rules/stream-interpretation.n3', 'utf8'),
].join('\n\n');

function enrichMessage(messageN3) {
  return reason({ proof: false }, `${background}\n\n${messageN3}`);
}

async function onMessage(messageN3) {
  const inferredN3 = enrichMessage(messageN3);

  // Application policy:
  // - parse inferredN3;
  // - remove duplicates already emitted;
  // - handle owlrl:Inconsistency reports;
  // - publish accepted new triples.
  return inferredN3;
}
```

For high-throughput systems, use Eyeling's streaming or RDF-JS APIs instead of repeatedly concatenating strings. The reasoning setup remains the same: static background knowledge plus one message or one window of messages.

## Testing examples

Each example should include:

1. background ontology;
2. stream interpretation rules, if needed;
3. one input message;
4. expected inferred triples.

Example command:

```bash
npx eyeling \
  rules/owl2rl-eyeling-possible.n3 \
  ontologies/domain.n3 \
  rules/stream-interpretation.n3 \
  examples/message-001.n3 \
  > /tmp/message-001.actual.n3
```

Then compare `/tmp/message-001.actual.n3` with `examples/message-001.expected.n3` using the repository's preferred RDF-aware comparison method.

Avoid byte-level comparison when blank nodes or generated Skolem IRIs are involved.

## Operational guidance

Use this setup when:

* RDF Messages are relatively small;
* the background ontology is mostly stable;
* inferred triples need to be generated at message time;
* explainable rule-based behavior is preferred over black-box enrichment;
* OWL 2 RL expressivity is sufficient.

Be careful when:

* message windows are large;
* transitive properties can create large closures;
* `owl:sameAs` can create many equivalent terms;
* property chains are long or recursive;
* the application depends on complete XSD datatype semantics.

## Known limitations

This ruleset is an OWL 2 RL implementation for what is currently practical in Eyeling N3. It is not a complete OWL 2 DL reasoner.

Known limitations include:

* incomplete XSD datatype reasoning (https://github.com/eyereasoner/eyeling/issues/18);
* no general OWL 2 DL tableau reasoning;
* no closed-world validation semantics;
* possible large materializations for transitive properties, property chains, and equality;
* stream state and duplicate suppression are handled by the application, not by the OWL 2 RL ruleset.

## Future work

Possible next steps:

* add Eyeling datatype built-ins for full OWL 2 RL datatype support;
* add a test corpus based on the OWL 2 RL rule tables;
* add examples for RDF Message Logs;
* add benchmark scenarios for stateless, stateful, and windowed stream reasoning;
* add output filters for common enrichment patterns;
* document recommended handling of `owlrl:Inconsistency` diagnostics.

## References

* OWL 2 RL profile: https://www.w3.org/TR/owl2-profiles/
* OWL 2 RL rules in RIF: https://www.w3.org/TR/rif-owl-rl/
* Notation3 Community Group specification: https://w3c-cg.github.io/N3/spec/
* Eyeling repository: https://github.com/eyereasoner/eyeling
* Eyeling built-ins catalog: https://github.com/eyereasoner/eyeling/blob/main/eyeling-builtins.ttl

