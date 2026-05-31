/**
 * BOB Sidekick — Google Apps Script Log Endpoint
 *
 * Deploy: Apps Script Editor → Deploy → New Deployment → Web App
 *   - Execute as: Me
 *   - Who has access: Anyone (if you accept that), or "Anyone within domain" (preferred)
 * Copy the deployment URL to n8n env: SHEETS_LOG_WEB_APP_URL
 *
 * Sheet: "BOB Conversation Log"
 * Sheet tabs: "conversations", "feedback"
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
const CONV_TAB = 'conversations';
const FEEDBACK_TAB = 'feedback';

const CONV_HEADERS = [
  'timestamp', 'trace_id', 'channel', 'user_id', 'user_name', 'department',
  'question', 'category', 'confidence', 'answer', 'sources', 'kb_relevance',
  'model', 'latency_ms', 'cache_hit', 'fallback_used', 'escalated', 'escalate_reason'
];

const FEEDBACK_HEADERS = [
  'timestamp', 'trace_id', 'user_id', 'feedback_type', 'correct_answer', 'notes', 'status'
];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);

    if (payload.event === 'feedback') {
      return appendRow(ss, FEEDBACK_TAB, FEEDBACK_HEADERS, {
        timestamp: new Date().toISOString(),
        trace_id: payload.trace_id || '',
        user_id: payload.user_id || '',
        feedback_type: payload.feedback_type || '',
        correct_answer: payload.correct_answer || '',
        notes: payload.notes || '',
        status: 'open'
      });
    }

    // Default: conversation log
    return appendRow(ss, CONV_TAB, CONV_HEADERS, {
      timestamp: new Date().toISOString(),
      trace_id: payload.trace_id || '',
      channel: payload.channel || '',
      user_id: payload.user_id || '',
      user_name: payload.user_name || '',
      department: payload.department || '',
      question: payload.question || '',
      category: payload.category || '',
      confidence: payload.confidence || 0,
      answer: (payload.answer || '').slice(0, 5000),
      sources: Array.isArray(payload.sources) ? payload.sources.join('|') : (payload.sources || ''),
      kb_relevance: payload.kb_relevance || 0,
      model: payload.model || '',
      latency_ms: payload.latency_ms || 0,
      cache_hit: payload.cache_hit ? 1 : 0,
      fallback_used: payload.fallback_used ? 1 : 0,
      escalated: payload.escalated ? 1 : 0,
      escalate_reason: payload.escalate_reason || ''
    });
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function appendRow(ss, tabName, headers, data) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // Ensure header exists
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  const row = headers.map(h => data[h] !== undefined ? data[h] : '');
  sheet.appendRow(row);
  return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: tabName }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    service: 'BOB Sidekick Log Endpoint',
    usage: 'POST JSON payload — see n8n Workflow A → Log node'
  })).setMimeType(ContentService.MimeType.JSON);
}

// One-time setup helper
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  [
    [CONV_TAB, CONV_HEADERS],
    [FEEDBACK_TAB, FEEDBACK_HEADERS]
  ].forEach(([tab, headers]) => {
    let s = ss.getSheetByName(tab);
    if (!s) s = ss.insertSheet(tab);
    if (s.getLastRow() === 0) {
      s.appendRow(headers);
      s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      s.setFrozenRows(1);
    }
  });
  Logger.log('Setup complete');
}
