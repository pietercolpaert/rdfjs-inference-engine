import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'rdf-parser-ts';
import { InferenceEngine } from '../../src';
import { assertContainsQuads, parseToQuads, writeQuads } from '../util';

const EX = 'https://example.org/logistics#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OWL = 'http://www.w3.org/2002/07/owl#';

async function main(): Promise<void> {
  const profile = readFileSync('rules/owl2rl-eyeling.n3', 'utf8');
  const ontology = parseToQuads(readFileSync('examples/shipment-logistics/ontology.n3', 'utf8'));
  const reasoner = new InferenceEngine();

  reasoner.load(profile, ontology);
  mkdirSync(dirname('generated/shipment-logistics-runtime.n3'), { recursive: true });
  reasoner.saveRuntime('generated/shipment-logistics-runtime.n3');

  const data = parseToQuads(readFileSync('examples/shipment-logistics/input.trig', 'utf8'));
  const closure = [...data, ...reasoner.infer(data)];
  const selected = selectedExpectedQuads();
  assertContainsQuads(closure, selected, 'Shipment logistics OWL 2 RL example');

  const output = await writeQuads(selected, {
    '': EX,
    owl: OWL,
  });

  process.stdout.write(output);
}

function selectedExpectedQuads(): Quad[] {
  const nn = DataFactory.namedNode;
  const q = DataFactory.quad;

  return [
    q(nn(`${EX}shipment-1`), nn(RDF + 'type'), nn(`${EX}ExpressShipment`)) as Quad,
    q(nn(`${EX}shipment-1`), nn(RDF + 'type'), nn(`${EX}Shipment`)) as Quad,
    q(nn(`${EX}shipment-1`), nn(RDF + 'type'), nn(`${EX}CountryDestinationShipment`)) as Quad,
    q(nn(`${EX}shipment-1`), nn(`${EX}requiresHandling`), nn(`${EX}carefulHandling`)) as Quad,
    q(nn(`${EX}shipment-1`), nn(`${EX}hasPart`), nn(`${EX}box-1`)) as Quad,
    q(nn(`${EX}alice`), nn(`${EX}handles`), nn(`${EX}shipment-1`)) as Quad,
    q(nn(`${EX}bob`), nn(`${EX}partnerOf`), nn(`${EX}alice`)) as Quad,
    q(nn(`${EX}box-1`), nn(`${EX}locatedIn`), nn(`${EX}warehouse-1`)) as Quad,
    q(nn(`${EX}tracking-a`), nn(OWL + 'sameAs'), nn(`${EX}tracking-b`)) as Quad,
    q(nn(`${EX}shipment-2`), nn(OWL + 'sameAs'), nn(`${EX}shipment-3`)) as Quad,
    q(nn(`${EX}item-9`), nn(RDF + 'type'), nn(`${EX}RegulatedItem`)) as Quad,
  ];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
