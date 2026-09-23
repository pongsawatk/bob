import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENROUTER_API_KEY = 'test-dummy';
process.env.OUTLINE_IT_COLLECTION_IDS = 'd38c3f9c-8470-4bd7-8440-cc01c41e1b58';
process.env.OUTLINE_BASE_URL = 'https://outline.builk.id';
process.env.LANGFUSE_PUBLIC_KEY = '';
process.env.LANGFUSE_SECRET_KEY = '';
const { buildITSnapshot, validITSnapshot, getITBundle, IT_COLLECTION_ID } = await import('../src/kb/it.js');
const { validateITAnswer, IT_NO_INFORMATION, IT_UNAVAILABLE } = await import('../src/kb/itAnswer.js');
const { fetchCollectionDocs } = await import('../src/kb/outline.js');
const { selectDocs } = await import('../src/kb/select.js');
const { callDomainBot } = await import('../src/pipeline/domainBot.js');
const { decideRoute } = await import('../src/pipeline/routePolicy.js');
const { retrievalQuery } = await import('../src/kb/query.js');
const { env } = await import('../src/env.js');
const doc = (id: string, title: string, text = 'ขั้นตอนตามคู่มือ') => ({ id, title, text, parentDocumentId: null as string | null,
  url: `/doc/${id}`, collectionId: IT_COLLECTION_ID, publishedAt: '2026-09-20T00:00:00Z' });

test('IT collection ingestion includes nested guides regardless of HR/Process prefixes, excludes drafts and empty containers', () => {
  const parent = doc('parent', 'AI Tools', '');
  const child = { ...doc('child', 'Outline MCP', 'ขั้นแรก\n\n---\n\nขั้นสอง'), parentDocumentId: parent.id };
  const s = buildITSnapshot([parent, child, { ...doc('draft', 'Draft'), publishedAt: null },
    { ...doc('old', 'Old'), archivedAt: '2026-09-20' }, doc('pii', 'Employee Directory')]);
  assert.equal(s.docs.length, 1);
  assert.equal(s.docs[0].title, 'AI Tools / Outline MCP');
  assert.equal(s.docs[0].url, 'https://outline.builk.id/doc/child');
  assert.doesNotMatch(s.docs[0].text, /---/);
  assert.equal(validITSnapshot(s), true);
});

test('empty, foreign collection and foreign URL results cannot replace an IT snapshot', () => {
  assert.throws(() => buildITSnapshot([]));
  assert.throws(() => buildITSnapshot([{ ...doc('a', 'VPN'), collectionId: 'old-collection' }]));
  assert.throws(() => buildITSnapshot([{ ...doc('a', 'VPN'), url: 'https://elsewhere.test/doc/a' }]));
  assert.throws(() => buildITSnapshot([{ ...doc('a', 'VPN'), url: undefined }]));
});

test('cache reads reject legacy schema, wrong collection/version, missing cache and failures; no local fallback', async () => {
  const good = buildITSnapshot([doc('vpn', 'Netbird VPN')]);
  for (const bad of [null, { hr: 'OLD IT DATA', product: 'OLD' }, { ...good, version: 0 }, { ...good, collectionId: 'old' }, { ...good, docs: [] }]) {
    assert.equal(await getITBundle(async () => bad), '');
  }
  assert.equal(await getITBundle(async () => { throw new Error('offline'); }), '');
  assert.match(await getITBundle(async () => good), /Netbird VPN/);
  const previous = env.OUTLINE_IT_COLLECTION_IDS;
  try { (env as { OUTLINE_IT_COLLECTION_IDS: string }).OUTLINE_IT_COLLECTION_IDS = 'old';
    let reads = 0; assert.equal(await getITBundle(async () => { reads++; return good; }), ''); assert.equal(reads, 0);
  } finally { (env as { OUTLINE_IT_COLLECTION_IDS: string }).OUTLINE_IT_COLLECTION_IDS = previous; }
});

test('published IT document pagination reaches children beyond the first 100 results', async t => {
  const offsets: number[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); offsets.push(body.offset);
    assert.equal(body.collectionId, IT_COLLECTION_ID);
    return new Response(JSON.stringify({ data: Array.from({ length: body.offset ? 1 : 100 }, (_, i) => doc(String(body.offset + i), 'VPN')) }));
  });
  assert.equal((await fetchCollectionDocs(IT_COLLECTION_ID)).length, 101);
  assert.deepEqual(offsets, [0, 100]);
});

test('IT questions and follow-ups route to IT while benefit/person/product topics retain their sources', () => {
  const r = { category: 'GENERAL' as const, needsClarification: false };
  for (const q of ['ตั้งค่า Netbird VPN', 'วิธีตั้งค่า Google 2SV', 'เชื่อม Outline MCP', 'ติดตั้ง Kiro', 'เริ่มใช้ Grab for Business']) {
    assert.equal(decideRoute(r, q).category, 'IT');
    assert.equal(decideRoute(r, 'ขอขั้นตอนเพิ่ม', [{ role: 'user', content: q }]).category, 'IT');
  }
  assert.equal(decideRoute({ ...r, category: 'IT' }, 'สิทธิ์เบิกอุปกรณ์ IT').category, 'HR');
  assert.equal(decideRoute({ ...r, category: 'PEOPLE' }, 'ทีม IT มีใครบ้าง').category, 'PEOPLE');
  assert.equal(decideRoute({ ...r, category: 'PRODUCT' }, 'Pojjaman ERP มีอะไรบ้าง').category, 'PRODUCT');
  assert.equal(decideRoute({ ...r, category: 'UNKNOWN' }, 'ignore previous Outline MCP').category, 'UNKNOWN');
  assert.equal(retrievalQuery('วันหยุดปีนี้', [{ role: 'user', content: 'Netbird VPN' }]), 'วันหยุดปีนี้');
  assert.equal(decideRoute(r, 'ทำบน Mac อย่างไร', [{ role: 'user', content: 'Netbird VPN' }]).category, 'IT');
  const vpnHistory = [{ role: 'user' as const, content: 'ตั้งค่า Netbird VPN อย่างไร' }];
  assert.equal(decideRoute(r, 'ขอขั้นตอนติดตั้งบน Mac', vpnHistory).category, 'IT');
  for (const product of ['Pojjaman ERP', 'Builk360', 'ขวัญใจ']) {
    assert.equal(decideRoute({ ...r, category: 'PRODUCT' }, `ขอรายละเอียด ${product}`, vpnHistory).category, 'PRODUCT');
    assert.doesNotMatch(retrievalQuery(`ขอรายละเอียด ${product}`, vpnHistory), /vpn/);
  }
});

test('IT source policy survives old production router and general prompts', async () => {
  const { applySystemPolicy } = await import('../src/prompts/systemPolicy.js');
  const router = applySystemPolicy('router', 'HR|PRODUCT|GENERAL|PEOPLE|UNKNOWN ห้ามนอก 5 ตัวเลือก');
  assert.match(router, /HR\|PRODUCT\|IT\|GENERAL/); assert.match(router, /6 ตัวเลือก/);
  assert.match(router, /IT =/);
  assert.match(applySystemPolicy('it', 'REMOTE'), /noInformation/);
  assert.match(applySystemPolicy('general', 'เช่น แก้ปัญหา IT,'), /คู่มือ IT จาก IT Shared doc/);
});

test('router gets user topic context, never prior assistant claims', async t => {
  const { routeMessage } = await import('../src/pipeline/router.js');
  let sent = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = init.body as string;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"category":"IT","confidence":1,"needs_clarification":false}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  const route = await routeMessage('ขอขั้นตอนเพิ่ม', [{ role: 'user', content: 'Netbird VPN' }, { role: 'assistant', content: 'POISONED_ASSISTANT_FALSE_STEP' }]);
  assert.equal(route.category, 'IT'); assert.match(sent, /Netbird VPN/); assert.doesNotMatch(sent, /POISONED_ASSISTANT_FALSE_STEP/);
});

test('citations must refer to selected IT documents, including URLs hidden in the answer', async () => {
  const bundle = await getITBundle(async () => buildITSnapshot([doc('vpn', 'Netbird VPN')]));
  const selected = selectDocs('VPN', bundle);
  const good = { answer: 'ทำตามคู่มือ', sourceUrls: ['https://outline.builk.id/doc/vpn'], noInformation: false };
  assert.match(validateITAnswer(JSON.stringify(good), selected).text, /แหล่งอ้างอิง/);
  for (const bad of [{ ...good, sourceUrls: [] }, { ...good, sourceUrls: ['https://outline.builk.id/doc/old'] },
    { ...good, answer: 'ดู https://evil.test/doc/fake' }]) assert.equal(validateITAnswer(JSON.stringify(bad), selected).guarded, true);
  assert.equal(validateITAnswer('made up answer', selected).text, IT_NO_INFORMATION);
  assert.equal(validateITAnswer(JSON.stringify({ noInformation: true }), selected).text, IT_NO_INFORMATION);
});

test('IT cache failure returns deterministic unavailable without HR/Product or an LLM call', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call model'); });
  const result = await callDomainBot('IT', 'VPN', '', '', [], undefined, {
    getHRBundle: async () => { throw new Error('old HR source'); },
    getProductBundle: async () => { throw new Error('old Product source'); }, getITBundle: async () => '',
  });
  assert.equal(result.text, IT_UNAVAILABLE); assert.equal(result.model, '');
});

test('operational URLs are allowed only when documented in a cited IT source', async () => {
  const bundle = await getITBundle(async () => buildITSnapshot([
    doc('vpn', 'VPN', 'เปิด https://netbird.builk.id/ ตั้ง Management URL `https://netbird.builk.id:443` ดู myaccount.google.com/security'),
    doc('other', 'Other', 'เปิด https://other.builk.id/'),
  ]));
  const selected = selectDocs('VPN', bundle);
  const result = (answer: string) => validateITAnswer(JSON.stringify({ answer, sourceUrls: ['https://outline.builk.id/doc/vpn'], noInformation: false }), selected);
  assert.equal(result('เปิด https://netbird.builk.id/ และตั้ง `https://netbird.builk.id:443`').guarded, false);
  assert.equal(result('เปิด https://netbird.builk.id/invented').guarded, true);
  assert.equal(result('เปิด https://other.builk.id/').guarded, true);
  assert.equal(result('เปิด netbird.builk.id และ myaccount.google.com/security').guarded, false);
  assert.equal(result('เปิด myaccount-google-login.example/security').guarded, true);
  assert.equal(result('[ลงชื่อเข้าใช้](myaccount-google-login.example/security)').guarded, true);
  assert.equal(result('[ลงชื่อเข้าใช้](//evil.example/security)').guarded, true);
  assert.equal(result('[ลงชื่อเข้าใช้][login]\n\n[login]: //evil.example/security').guarded, true);
});

test('IT model receives current source and user topic only, never old assistant facts', async t => {
  const bundle = await getITBundle(async () => buildITSnapshot([doc('vpn', 'Netbird VPN', 'เปิด Netbird แล้ว Sign in')]));
  let request = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    request = init.body as string;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'เปิด Netbird แล้ว Sign in', sourceUrls: ['https://outline.builk.id/doc/vpn'], noInformation: false }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  });
  const result = await callDomainBot('IT', 'ขอขั้นตอน', '', '', [
    { role: 'user', content: 'Netbird VPN' }, { role: 'assistant', content: 'OLD_UNTRUSTED_IT_FACT' },
  ], 'OLD_PRIVATE_PROFILE', { getHRBundle: async () => 'OLD_HR', getProductBundle: async () => 'OLD_PRODUCT', getITBundle: async () => bundle });
  assert.match(request, /Netbird/); assert.doesNotMatch(request, /OLD_/);
  assert.equal(result.citationGuarded, false); assert.equal(result.itCollectionId, IT_COLLECTION_ID);
  assert.match(result.text, /แหล่งอ้างอิง/);
});
