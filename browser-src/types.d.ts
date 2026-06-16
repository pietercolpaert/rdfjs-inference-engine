declare module 'bundled-rules' {
  export const bundledRuleFiles: string[];
  export const bundledRuleProfiles: Array<{
    file: string;
    n3: string;
  }>;
  export const bundledRules: string;
}

declare module 'bundled-examples' {
  export const bundledExamples: Array<{
    id: string;
    label: string;
    backgroundFile: string;
    dataFile: string;
    background: string;
    data: string;
    shaclInFile?: string;
    shaclOutFile?: string;
    shaclIn?: string;
    shaclOut?: string;
  }>;
}

declare module '*.n3' {
  const source: string;
  export default source;
}

declare module '*.trig' {
  const source: string;
  export default source;
}