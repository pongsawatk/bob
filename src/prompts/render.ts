/** Literal replacement: KB text containing $&, $$ or $' must survive unchanged. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z_]+)\}\}/g, (token, key: string) => values[key] ?? token);
}
