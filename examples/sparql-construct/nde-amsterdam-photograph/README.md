# Amsterdam archival photographs → a heritage discovery portal

An illustrative example inspired by [Netwerk Digitaal Erfgoed's guidance on publishing collection information with Schema.org](https://netwerkdigitaalerfgoed.nl/wegwijzer/verspreiden/). It describes fictional photographs of Amsterdam's canals; it is not a real archive export or an official NDE SHACL profile. Photographer, photograph, and subject identifiers use example URIs.

Select **Amsterdam archival photographs (NDE-inspired)** in the SPARQL CONSTRUCT playground. The ontology, provider shape, consumer shape, and input messages load together. The engine’s bundled OWL 2 RL rules express the ontology entailment. Generation unfolds this example into one self-contained CONSTRUCT. Use **Run SPARQL CONSTRUCT** to execute the displayed query with the locally bundled Comunica engine. Constructed triples are deduplicated, including types repeated across matching field rows. The expected output fixture is available in this example directory.

The ontology explicitly provides these directional relationships:

| Source | Consumer |
| --- | --- |
| `archive:ArchivalPhotograph` | subclass of `schema:Photograph` |
| `dcterms:title` | subproperty of `schema:name` |
| `dcterms:creator` | subproperty of `schema:creator` |
| `dcterms:created` | subproperty of `schema:dateCreated` |
| `dcterms:subject` | subproperty of `schema:about` |
| `dcterms:license` | subproperty of `schema:license` |

These statements describe the vocabulary alignment assumed by this collection example. Removing them prevents the translated entailment rules from producing the mapped fields; the generator does not match field names heuristically.

The title is required. Photographer, date, subject, and licence are optional. Titles use `sh:nodeKind sh:Literal` so Dutch language tags survive; dates use `xsd:date`, and linked identifiers are IRIs. The two messages demonstrate a fully described photograph and a photograph with an unknown maker and date. Each message is queried separately, keeping original identifiers and message boundaries.

Files:

- `ontology.ttl`: the explicit collection ontology and mappings.
- `shapes-in.ttl`: the provider's Dublin Core contract.
- `shapes-out.ttl`: the portal's Schema.org contract.
- `input.messages.trig`: two fictional archival photograph records.
- `expected-output.messages.trig`: the corresponding Schema.org messages.

Run `npm run test:sparql-construct` to verify both the generator and the actual browser Comunica worker bundle against these fixtures.
