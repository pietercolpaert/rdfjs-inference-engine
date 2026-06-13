# Inconsistency diagnostics example

This playground example shows how application-facing inconsistency diagnostics are reported for ordinary RDF input.

The ontology declares two disjoint classes:

- `:A owl:disjointWith :B`

The RDF input contains two conflicting facts:

1. `:x a :A`
2. `:x a :B`

The engine reports one public `cax-dw` inconsistency and hides any internal OWL helper diagnostics that mention generated Skolem IRIs.
