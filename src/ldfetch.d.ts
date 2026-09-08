declare module 'ldfetch' {
  import type { Quad } from '@rdfjs/types';

  export type LdFetchResponse = {
    triples?: Iterable<Quad>;
    messages?: Iterable<Iterable<Quad>>;
    prefixes?: Record<string, string>;
    statusCode?: number;
    responseCode?: number;
    url?: string;
  };

  export default class LDFetch {
    constructor(options?: Record<string, unknown>);
    get(url: string): Promise<LdFetchResponse>;
  }
}