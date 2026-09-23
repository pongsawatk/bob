# IT knowledge: exclusive IT Shared doc source

Approved scope: technical setup, usage and troubleshooting use IT Shared doc only.
Equipment benefits remain HR; employee/team lookup remains PEOPLE; product features remain PRODUCT.

## Source and runtime

- Collection: `d38c3f9c-8470-4bd7-8440-cc01c41e1b58`
- URL: https://outline.builk.id/collection/it-shared-doc-8oeX9tBu9g/
- Set `OUTLINE_IT_COLLECTION_IDS` to this exact ID. Empty/other values cannot serve IT knowledge.
- `MODEL_IT` is optional; defaults to the configured HR model.
- Published, non-archived documents with body content are collected with pagination and parent paths.
- Membership and source URLs are checked before caching. A zero-document refresh fails without replacing a valid IT snapshot.
- Redis key: `bob:kb:it:v1:d38c3f9c-8470-4bd7-8440-cc01c41e1b58`. Content, source identity, schema version and timestamp are one atomic value.
- Each IT request reads this key; there is no legacy bundle, local wiki or stale in-memory fallback.
- Redis unavailable, incompatible snapshot or unconfigured source produces an unavailable response and collection link; no model call.
- User history may supply a topic. Assistant history and employee profile are excluded from IT generation.
- IT generation returns structured text/source URLs. Unknown citations and unrelated URLs are rejected in code. Citation membership does not prove semantic correctness; live evaluation remains necessary.
- Shared refresh includes IT when configured. `node --import tsx scripts/refresh-it-kb.ts` validates without writing; add `--write` to refresh only IT and verify cache read-back.

## Rollout sequence

1. Check the canonical Vercel project `bob` and its production Outline token's access.
2. Run regression tests, typecheck, build and live evaluation (real document egress must be authorized).
3. Create candidate Langfuse `it`, `router`, `general` prompts, preserving current remote changes. Record previous/new versions.
4. Save the validated IT snapshot; set the production IT source ID. Existing production code ignores this isolated key/variable.
5. Push the tested commit to `main` (the project's documented deployment path), wait for the canonical deployment to become READY.
6. Promote the reviewed prompt candidates, verify production read-back, then exercise the authenticated `/api/chat` endpoint.
7. Test Netbird, Google 2SV, Outline MCP, an undocumented request, equipment benefit, product overview, and user-only follow-up context. Inspect source links and traces.

Do not broadcast a message to staff as part of this deployment. Actual Teams delivery is a separate user acceptance check.

## Failure recovery

- Do not repoint IT to the old collection or copy old local IT files into its cache.
- If IT must be suspended, clear the IT source setting and redeploy the new code: IT requests return unavailable without a legacy fallback.
- A prompt rollback must retain the IT source policy. Restoring pre-IT application code would restore old routing behavior and is not a source-safe rollback.
- A failed refresh with the same approved collection keeps the last valid IT snapshot. To revoke stale information immediately, suspend IT and refresh a corrected snapshot before re-enabling it.

## Validation at implementation

- Local BOB Outline token read 16 published documents with content on 2026-09-23.
- Automated coverage includes nested/paginated documents, wrong collection/URL, draft/archived/empty docs, missing/invalid cache, source citation enforcement, source isolation, history isolation and IT/HR/PEOPLE/PRODUCT routing.
- Production activation and live evaluation status are recorded after execution, not inferred from local tests.

## Release verification (2026-09-23)

- User authorized Git/Vercel deployment and repeated independent Sol High testing after the real-document egress question.
- 313/313 automated tests passed; TypeScript typecheck and build passed.
- Live local evaluation: Netbird, Google 2SV and Outline MCP answered with approved IT citations; undocumented PlayStation VPN declined; equipment benefit/employee/product questions routed correctly.
- Fixed the live-test finding that operational URLs in documented procedures were incorrectly rejected. Operational URLs now must occur in the cited IT document; source citations still must refer to selected IT documents.
- Latest local Outline read: 17 published documents with content. Counts may change as IT maintains the collection.
- Langfuse candidates created and read back: it v1, router v5 (previous production v4), general v4 (previous production v3).
- Authenticated POST /api/chat action refresh-it verifies actual production Outline and Redis access and returns source/count only. CHAT_TEST_KEY protects both this operation and test conversations. Test history accepts at most 14 user/assistant messages.
- Release proceeds via git push main, then production refresh/read-back, prompt promotion and independent production tests. Final evidence is recorded in the test report after those checks.
