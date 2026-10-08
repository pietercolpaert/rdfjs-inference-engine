import qudtOntology from '../examples/sparql-construct/qudt-museum-dimensions/ontology.ttl';
import qudtIn from '../examples/sparql-construct/qudt-museum-dimensions/shapes-in.ttl';
import qudtOut from '../examples/sparql-construct/qudt-museum-dimensions/shapes-out.ttl';
import qudtData from '../examples/sparql-construct/qudt-museum-dimensions/input.messages.trig';
import qudtExpected from '../examples/sparql-construct/qudt-museum-dimensions/expected-output.messages.trig';
import ontology from '../examples/sparql-construct/nde-amsterdam-photograph/ontology.ttl';
import shaclIn from '../examples/sparql-construct/nde-amsterdam-photograph/shapes-in.ttl';
import shaclOut from '../examples/sparql-construct/nde-amsterdam-photograph/shapes-out.ttl';
import data from '../examples/sparql-construct/nde-amsterdam-photograph/input.messages.trig';
import expected from '../examples/sparql-construct/nde-amsterdam-photograph/expected-output.messages.trig';

const prefixes = '@prefix ex: <https://example.org/> .\n@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n';
export const constructExamples = [
  { id: 'nde-amsterdam-photograph', label: 'Amsterdam archival photographs (NDE-inspired)',
    description: 'Illustrative Amsterdam canal photographs: Dublin Core collection metadata → Schema.org for a heritage discovery portal. The ontology explicitly aligns the photograph class and all five fields. Dutch titles and linked identifiers are preserved; photographer and date can be unknown. These are fictional records and example mappings, not an official NDE profile.',
    ontology, shaclIn, shaclOut, data, expected },
  { id: 'qudt-museum-dimensions', label: 'Museum object heights (QUDT: cm/mm → m)',
    description: 'Fictional museum measurements: a Delftware vase (32 cm → 0.32 m), a display case (450 mm → 0.45 m), and a cabinet already measured in metres. QUDT dimension vectors and conversion factors from the ontology become VALUES and BIND arithmetic in the generated query. Comunica converts the values and writes unit:M while preserving identifiers and message boundaries.',
    ontology: qudtOntology, shaclIn: qudtIn, shaclOut: qudtOut, data: qudtData, expected: qudtExpected },
  { id: 'sensor-reading', label: 'Sensor readings',
    description: 'Map temperature readings to an observation contract, preserving optional timestamps.',
    ontology: prefixes + 'ex:SensorReading rdfs:subClassOf ex:Observation .\nex:temperature rdfs:subPropertyOf ex:value .\nex:recordedAt owl:equivalentProperty ex:time .\n',
    shaclIn: prefixes + 'ex:ProviderShape a sh:NodeShape ;\n  sh:targetClass ex:SensorReading ;\n  sh:property [ sh:path ex:temperature ; sh:datatype xsd:decimal ; sh:minCount 1 ] ;\n  sh:property [ sh:path ex:recordedAt ; sh:datatype xsd:dateTime ] .\n',
    shaclOut: prefixes + 'ex:ConsumerShape a sh:NodeShape ;\n  sh:targetClass ex:Observation ;\n  sh:property [ sh:path ex:value ; sh:datatype xsd:decimal ; sh:minCount 1 ] ;\n  sh:property [ sh:path ex:time ; sh:datatype xsd:dateTime ] .\n',
    data: prefixes + 'ex:reading-1 a ex:SensorReading ; ex:temperature "18.4"^^xsd:decimal ; ex:recordedAt "2026-10-08T12:00:00Z"^^xsd:dateTime .\n',
    expected: prefixes + 'ex:reading-1 a ex:Observation ; ex:value "18.4"^^xsd:decimal ; ex:time "2026-10-08T12:00:00Z"^^xsd:dateTime .\n' },
];
