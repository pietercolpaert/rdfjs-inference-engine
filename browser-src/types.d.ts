declare module 'bundled-rules' {
  export const bundledRuleFiles: string[];
  export const bundledRules: string;
}

declare module '*.n3' {
  const source: string;
  export default source;
}

declare module '*.trig' {
  const source: string;
  export default source;
}