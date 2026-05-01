declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.json' {
  const value: unknown;
  export default value;
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { eager?: boolean; import?: string; query?: string },
  ): Record<string, T>;
}
