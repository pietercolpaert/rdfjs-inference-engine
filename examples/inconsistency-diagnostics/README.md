# Inconsistency diagnostics example

This playground example shows how application-facing inconsistency diagnostics are reported for RDF Messages with stateful materialization enabled.

The ontology declares two disjoint classes:

- `:A owl:disjointWith :B`

The RDF Messages input then splits the conflicting facts across two messages:

1. `:x a :A`
2. `:x a :B`

When the playground processes the messages with stateful materialization, the second message is checked together with the first message's retained facts. The engine reports one public `cax-dw` inconsistency and hides any internal OWL helper diagnostics that mention generated Skolem IRIs.
