import { bundledExamples } from 'bundled-examples';

// Both playgrounds load these exact same RDF fixtures and labels.
export const constructExamples = bundledExamples.map(example => ({
  id: example.id,
  label: example.label,
  description: example.description,
  ontology: example.background,
  shaclIn: example.shaclIn,
  shaclOut: example.shaclOut,
  data: example.data,
}));
