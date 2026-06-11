import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { InferenceEngine, loadDefaultRuleProfiles, type RuntimeCompilerInput } from '../src';

const expectedLabels = readdirSync('rules')
  .filter((file) => file.endsWith('.n3'))
  .sort()
  .map((file) => `rules/${file}`);

assert.ok(expectedLabels.length > 0, 'Expected at least one bundled N3 rule profile.');

const defaultProfiles = loadDefaultRuleProfiles();
assert.deepEqual(
  defaultProfiles.map((profile) => profile.label),
  expectedLabels,
  'loadDefaultRuleProfiles() should load every bundled rules/*.n3 file in sorted order.',
);

let compilerInput: RuntimeCompilerInput | undefined;
const reasoner = new InferenceEngine();
reasoner.load([], {
  runtimeCompiler: (input) => {
    compilerInput = input;
    return input.profileN3;
  },
});

assert.ok(compilerInput, 'Expected the runtime compiler to be called.');
assert.deepEqual(
  compilerInput.profiles.map((profile) => profile.label),
  expectedLabels,
  'load(vocabularyDataset) should use every bundled rules/*.n3 file by default.',
);

console.log(`Default rule loading tests: ${expectedLabels.length}/${expectedLabels.length} profiles loaded.`);
