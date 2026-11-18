/** Remove credential values before model, log, and evaluation boundaries.
 * Public instructions and explicit placeholders remain usable. Never logs values. */
const LABEL = /(?:password|passwd|pwd|(?:api|private|secret)[_ -]?key|access[_ -]?token|client[_ -]?secret|รหัสผ่าน|รหัส\s*(?:wifi|wi-fi|door(?:\s*lock)?))/i;
const PLACEHOLDER = /^(?:\[REDACTED\]|<[^>]+>|\$\{[^}]+\}|\$[A-Z_]+|YOUR[_ -][A-Z_ -]+|\*+|x{4,}|-{2,})$/i;
export function sanitizeCredentials(input: string): string {
  // Sanitize parsed JSON values, then encode again: a password inside an
  // answer string must not insert unescaped quotes and break the response.
  if (/^\s*[\[{]/.test(input)) {
    try { return JSON.stringify(sanitizeCredentialData(JSON.parse(input))); } catch { /* Plain prose/Markdown. */ }
  }
  let text = input.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]');
  text = text.replace(/\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+(?!<|YOUR_|\[REDACTED\])[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [REDACTED]');
  let secretColumns: number[] = [];
  return text.split('\n').map(line => {
    if (line.trim().startsWith('|')) {
      const cells = line.split('|');
      const labels = cells.map((c,i) => LABEL.test(c) ? i : -1).filter(i=>i>=0);
      const separator = cells.filter(c=>c.trim()).every(c=>/^\s*:?-+:?\s*$/.test(c));
      if (separator) return line;
      if (secretColumns.length && !labels.length) {
        for (const i of secretColumns) if (cells[i]?.trim() && !PLACEHOLDER.test(cells[i]!.trim().replace(/`/g,''))) cells[i]=' [REDACTED] ';
        return cells.join('|');
      }
      if (labels.length) {
        // A credential key/value row differs from a column header table.
        if (cells.filter(c=>c.trim()).length===2 && labels.includes(1)) {
          const value=cells[2]!.trim().replace(/`/g,'');
          if (value && !PLACEHOLDER.test(value)) cells[2]=' [REDACTED] ';
        } else secretColumns=labels;
        return cells.join('|');
      }
      return line;
    }
    secretColumns=[];
    // JSON, env assignments, Markdown labels and inline code values.
    return line.replace(/((?:["'`*]*)(?:password|passwd|pwd|(?:api|private|secret)[_ -]?key|access[_ -]?token|client[_ -]?secret|รหัสผ่าน|รหัส\s*(?:wifi|wi-fi|door(?:\s*lock)?))["'`*]*\s*[:=]\s*)([^\n]+)/gi,
      (_all, prefix: string, rest: string) => {
        const match = /^(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^,;}]+))/.exec(rest);
        if (!match) return prefix+rest;
        const value=(match[1]??match[2]??match[3]??match[4]??'').trim();
        if (PLACEHOLDER.test(value)) return prefix+rest;
        return prefix+'"[REDACTED]"'+rest.slice(match[0].length);
      });
  }).join('\n');
}

/** Preserve object shape so telemetry can sanitize all nested strings. */
export function sanitizeCredentialData<T>(value: T): T {
  if (typeof value==='string') return sanitizeCredentials(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeCredentialData) as T;
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,LABEL.test(k)&&typeof v==='string'&&!PLACEHOLDER.test(v)?'[REDACTED]':sanitizeCredentialData(v)])) as T;
  return value;
}
