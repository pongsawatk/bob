// People Connector — audit log (plan §8, WP-22.4). Records ONLY {subIntent,
// policyOutcome, resultCount, timestamp}. Never the query text (so a refused,
// sensitive query is never copied) and never a technical id. record() copies
// only those four fields, so extra data a caller passes is dropped by design.

import { PC_CONFIG } from "../pcConfig.js";
import type { PolicyOutcome, SubIntent } from "../pcTypes.js";

export interface AuditEvent {
  subIntent: SubIntent;
  policyOutcome: PolicyOutcome;
  resultCount: number;
  timestamp: number;
}

const DAY_MS = 864e5;

export interface AuditLog {
  record(e: { subIntent: SubIntent; policyOutcome: PolicyOutcome; resultCount: number; timestamp?: number }): AuditEvent;
  all(): AuditEvent[];
  /** Drop events older than AUDIT_RETENTION_DAYS; returns how many were removed. */
  prune(now?: number): number;
}

export function createAuditLog(): AuditLog {
  const events: AuditEvent[] = [];
  return {
    record(e) {
      // Explicitly copy only the allowlisted fields — never query text / ids.
      const evt: AuditEvent = {
        subIntent: e.subIntent,
        policyOutcome: e.policyOutcome,
        resultCount: e.resultCount,
        timestamp: e.timestamp ?? Date.now(),
      };
      events.push(evt);
      return evt;
    },
    all() {
      return events.map((e) => ({ ...e }));
    },
    prune(now = Date.now()) {
      const cutoff = now - PC_CONFIG.AUDIT_RETENTION_DAYS * DAY_MS;
      let removed = 0;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.timestamp < cutoff) {
          events.splice(i, 1);
          removed++;
        }
      }
      return removed;
    },
  };
}
