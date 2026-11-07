import type { Artifact, CatalogClient, Format, SearchHit } from '@neverblink/ohi' with { 'resolution-mode': 'import' };

export interface OhiSearchOptions {
  /** A `CatalogClient` from `@neverblink/ohi`, or a stand-in with the same methods. */
  client: Pick<CatalogClient, 'search' | 'inspect'>;
  input: HTMLInputElement;
  results: HTMLElement;
  status: HTMLElement;
  /** URL field of the editor the chosen ontology is loaded into. */
  urlInput: HTMLInputElement;
  loader: { load(): Promise<void> };
}

/** Formats the playground can load, in order of preference. */
const rdfFormats: Format[] = ['owl-turtle', 'rdfs-turtle', 'owl-rdfxml'];
/** Search filter that keeps only ontologies with at least one of `rdfFormats`. */
const rdfFormatFilter = `formats:=[${rdfFormats.join(',')}]`;
const searchDelayMs = 300;
const externalLinkIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

type Release = { namespace: string; name: string; version: string };

/** Page of one release on ohi.dev, such as https://ohi.dev/o/w3c/sosa@2017. */
export function ohiReleasePage(release: Release): string {
  return `https://ohi.dev/o/${encodeURIComponent(release.namespace)}/${encodeURIComponent(release.name)}@${encodeURIComponent(release.version)}`;
}

/** Pick the artifact to load: OWL in Turtle first, upstream files before generated ones. */
export function pickRdfArtifact(artifacts: Artifact[]): Artifact | undefined {
  for (const format of rdfFormats) {
    const candidates = artifacts.filter(artifact => artifact.format === format);
    const artifact = candidates.find(candidate => candidate.origin === 'UPSTREAM') ?? candidates[0];
    if (artifact) return artifact;
  }
  return undefined;
}

/** Search ohi.dev as the user types and load the chosen ontology through the editor's URL loader. */
export function createOhiSearch(options: OhiSearchOptions): { search(): Promise<void>; reset(): void } {
  const { client, input, results, status, urlInput, loader } = options;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearResults = () => {
    results.replaceChildren();
    results.hidden = true;
  };
  const search = async () => {
    clearTimeout(timer);
    const query = input.value.trim();
    const currentGeneration = ++generation;
    if (!query) {
      clearResults();
      status.textContent = '';
      return;
    }
    status.textContent = 'Searching ohi.dev…';
    try {
      const page = await client.search({ q: query, per_page: 10, filter_by: rdfFormatFilter });
      if (generation !== currentGeneration) return;
      results.replaceChildren(...page.hits.map(hit => resultItem(hit, () => void select(hit))));
      results.hidden = page.hits.length === 0;
      status.textContent = page.hits.length === 0
        ? `No ontologies with an RDF file found for “${query}”.`
        : `${page.total}${page.search_cutoff ? '+' : ''} ${page.total === 1 ? 'result' : 'results'} on ohi.dev. Choose one to load it.`;
    } catch (error) {
      if (generation === currentGeneration) status.textContent = `Could not search ohi.dev: ${errorMessage(error)}`;
    }
  };
  const select = async (hit: SearchHit) => {
    const currentGeneration = ++generation;
    clearTimeout(timer);
    status.textContent = `Reading ${hit.title} on ohi.dev…`;
    try {
      const publication = await client.inspect(hit.base_url);
      if (generation !== currentGeneration) return;
      const artifact = pickRdfArtifact(publication.artifacts);
      if (!artifact) {
        status.textContent = `${publication.title} has no RDF file on ohi.dev.`;
        return;
      }
      clearResults();
      const licenses = publication.licenses.length > 0 ? publication.licenses.join(', ') : 'not stated';
      const page = document.createElement('a');
      page.href = ohiReleasePage(publication);
      page.target = '_blank';
      page.rel = 'noopener';
      page.textContent = releaseLabel(publication);
      status.textContent = `${publication.title} (`;
      status.append(page, `, ${artifact.format}, ${formatBytes(artifact.size_bytes)}) from ohi.dev. License: ${licenses}.`);
      urlInput.value = artifact.url;
      await loader.load();
    } catch (error) {
      if (generation === currentGeneration) status.textContent = `Could not read ${hit.title} on ohi.dev: ${errorMessage(error)}`;
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void search(); }, searchDelayMs);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void search(); }
  });
  return { search, reset: () => {
    generation++;
    clearTimeout(timer);
    input.value = '';
    clearResults();
    status.textContent = '';
  } };
}

function releaseLabel(release: Release): string {
  return `${release.namespace}/${release.name}@${release.version}`;
}

function resultItem(hit: SearchHit, onSelect: () => void): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'ohi-item';
  const button = document.createElement('button');
  button.type = 'button';
  const title = document.createElement('span');
  title.className = 'ohi-hit-title';
  title.textContent = hit.title;
  const meta = document.createElement('span');
  meta.className = 'ohi-hit-meta';
  meta.textContent = [releaseLabel(hit), ...hit.licenses].join(' · ');
  const description = document.createElement('span');
  description.className = 'ohi-hit-description';
  description.textContent = hit.description;
  button.append(title, meta, description);
  button.addEventListener('click', onSelect);
  const page = document.createElement('a');
  page.className = 'ohi-view';
  page.href = ohiReleasePage(hit);
  page.target = '_blank';
  page.rel = 'noopener';
  page.title = 'View on ohi.dev';
  page.setAttribute('aria-label', `View ${hit.title} ${hit.version} on ohi.dev (opens in a new tab)`);
  page.innerHTML = externalLinkIcon;
  item.append(button, page);
  return item;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
