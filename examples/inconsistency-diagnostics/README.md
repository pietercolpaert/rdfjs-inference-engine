# Inconsistency diagnostics example

This playground example shows how application-facing inconsistency diagnostics are reported for ordinary RDF input.

The ontology declares two disjoint classes:

- `:A owl:disjointWith :B`

The RDF input contains two conflicting facts:

1. `:x a :A`
2. `:x a :B`

The engine reports one public `cax-dw` inconsistency and hides any internal OWL helper diagnostics that mention generated Skolem IRIs. The output contains machine-readable triples using the [inconsistency vocabulary](https://www.pieter.pm/rdfjs-inference-engine/ns/inconsistencies), in addition to the playground's explanatory comments.

The report is represented as:

```turtle
<generated-report> a inconsistencies:Inconsistency ;
  inconsistencies:rule inconsistencies:cax-dw ;
  inconsistencies:term1 :A ;
  inconsistencies:term2 :B ;
  inconsistencies:term3 :x .
```
