// ===============================================
// Code.gs（完全版：簡易認可つき）
// 目的：ID直書き廃止 / 競合ロック / 出題バリデーション / ドメイン整形 / 許可リスト認可
// ===============================================

const APP_VERSION = 'v0.3.0 (2025-09-15 JST)';

// ===== 設定 =====
const SHEET_QUESTIONS = 'Questions';
const SHEET_RESPONSES = 'Responses';

/** Script Properties からIDを取得（未設定ならエラー） */
function getSpreadsheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not set in Script Properties');
  return id;
}
/** 初回だけ実行してIDを保存（必要なら） */
function setSpreadsheetId(id) {
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
  return { ok: true };
}

// ====== 簡易認可（許可リスト） ======
// 全角→半角 & 不可視文字除去 & trim
function normalizeUserId_(s) {
  s = String(s || '');

  // ゼロ幅/不可視
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 全角→半角（英数記号）
  // ！(FF01)〜～(FF5E) を -0xFEE0、全角スペースは半角スペースへ
  s = s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
       .replace(/　/g, ' ');

  // 念のためハッシュは明示置換
  s = s.replace(/＃/g, '#');

  // 前後の空白除去
  s = s.trim();

  return s;
}

function getAllowList_() {
  const raw = PropertiesService.getScriptProperties().getProperty('USER_ALLOW_LIST') || '';
  return raw.split(/\r?\n/)
    .map(s => normalizeUserId_(s))
    .filter(s => s && !s.startsWith('#'));
}

function isAllowed_(user_id) {
  const list = getAllowList_();                 // すでに正規化済みリスト
  if (list.length === 0) return true;           // 未設定＝全許可（テスト用）
  const uid = normalizeUserId_(user_id);        // 呼び出し値も正規化
  return list.indexOf(uid) >= 0;                // 完全一致でOK
}

function mustAllow_(user_id) {
  if (!isAllowed_(user_id)) {
    // よくある原因ヒントを付ける（全角/半角）
    throw new Error('FORBIDDEN: user_id is not allowed (hint: check full-width digits/#)');
  }
}


// ===== エントリポイント =====
function doGet() {
  const t = HtmlService.createTemplateFromFile('index');
  return t.evaluate()
    .setTitle('さんすうドリル（小3）')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ===== ヘルスチェック =====
function healthCheck() {
  ensureSheets_(); // 先に自己修復

  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  const q = ss.getSheetByName(SHEET_QUESTIONS);
  const r = ss.getSheetByName(SHEET_RESPONSES);

  return {
    ok: true,
    hasQuestions: !!q,
    hasResponses: !!r,
    timeZone: Session.getScriptTimeZone(),
    version: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : 'unknown',
    serverNow: new Date()
  };
}

/**
 * シートの自己修復（Responses だけ最低限のヘッダを保証）
 */
function ensureSheets_() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  const r = ss.getSheetByName(SHEET_RESPONSES) || ss.insertSheet(SHEET_RESPONSES);
  const header = ['timestamp','user_id','qid','chosen','correct','elapsed_ms','device'];

  const range = r.getRange(1, 1, 1, header.length);
  const values = range.getValues()[0];
  const mismatch = header.some((h, i) => String(values[i] || '').trim() !== h);
  if (mismatch) {
    range.setValues([header]);
  }
}

// ===== データ取得API =====
function getDomains() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  const sh = ss.getSheetByName(SHEET_QUESTIONS);
  if (!sh) throw new Error('Questions シートが見つかりません');

  const data = sh.getDataRange().getValues();
  const header = data.shift();
  const idxDomain = header.indexOf('domain');
  if (idxDomain === -1) throw new Error('Questions ヘッダに domain 列がありません');

  const set = {};
  data.forEach(r => {
    const d = String(r[idxDomain] || '').trim();
    if (d) set[d] = true;
  });

  // ユニーク＋日本語ロケールで安定ソート
  return Object.keys(set).sort((a, b) => a.localeCompare(b, 'ja'));
}


// ========= 追加：tags から group と step を読むヘルパ =========
function parseGroupStep_(tagsStr) {
  const t = String(tagsStr || '');
  // group:xxxx を拾う
  const g = (t.match(/(?:^|\|)group:([^|]+)/) || [])[1] || '';
  // step:数字 を拾う（数字でなければ NaN → null）
  const sRaw = (t.match(/(?:^|\|)step:(\d+)/) || [])[1];
  const s = sRaw ? parseInt(sRaw, 10) : null;
  return { group: g, step: isFinite(s) ? s : null };
}


// ========= 修正：getQuestions（順番制御を追加） =========
function getQuestions(params) {
  const domain = params && params.domain ? params.domain : '';
  const user_id = params && params.user_id ? String(params.user_id) : '';
  mustAllow_(user_id);

  // 並び制御パラメータ（sequential なら順番固定）
  const order = params && params.order ? String(params.order) : 'random';

  // limitの安全化（1〜50にクランプ）※A全問を想定して 50 で十分
  let limit  = params && params.limit ? Number(params.limit) : 5;
  if (!isFinite(limit)) limit = 5;
  limit = Math.max(1, Math.min(50, Math.floor(limit)));

  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  const sh = ss.getSheetByName(SHEET_QUESTIONS);
  if (!sh) throw new Error('Questions シートが見つかりません');

  const data = sh.getDataRange().getValues();
  const header = data.shift();

  const need = [
    'qid','grade','domain','skill','stem','choices','correct',
    'distractor_reason_A','distractor_reason_B','distractor_reason_C','distractor_reason_D',
    'assets','difficulty','tags'
  ];
  const map = {};
  need.forEach(k => {
    const idx = header.indexOf(k);
    if (idx === -1) throw new Error('Questions ヘッダに ' + k + ' 列がありません');
    map[k] = idx;
  });

  // qid の数値比較用に数値化を試みる（失敗時は文字列比較）
  function toNumOrStr(x) {
    const n = Number(x);
    return isFinite(n) ? n : String(x || '');
  }

  const pool = data
    .filter(r => String(r[map['domain']] || '').trim() === domain || !domain)
    .map(r => {
      const choices = String(r[map['choices']] || '')
        .split('|')
        .map(s => String(s || '').trim())
        .slice(0, 4);

      const qid = String(r[map['qid']]);
      const tags = String(r[map['tags']]);
      const gs = parseGroupStep_(tags);

      return {
        qid: qid,
        qidSort: toNumOrStr(qid),
        domain: String(r[map['domain']]),
        skill: String(r[map['skill']]),
        stem: String(r[map['stem']]),
        choices: choices,
        correct: String(r[map['correct']]).toUpperCase(),
        reasons: {
          A: String(r[map['distractor_reason_A']]),
          B: String(r[map['distractor_reason_B']]),
          C: String(r[map['distractor_reason_C']]),
          D: String(r[map['distractor_reason_D']]),
        },
        assets: String(r[map['assets']]),
        difficulty: Number(r[map['difficulty']] || 2),
        tags: tags,
        // 追加：並び制御用
        group: gs.group,
        step: gs.step
      };
    })
    .filter(q => {
      const okChoices = Array.isArray(q.choices) && q.choices.length === 4 && q.choices.every(s => s !== '');
      const okCorrect = ['A', 'B', 'C', 'D'].indexOf(q.correct) >= 0;
      const okQid     = q.qid !== '';
      return okChoices && okCorrect && okQid;
    });

  // === 並び順 ===
  if (order === 'sequential') {
    // 1) キー（group or qid）でまとめる
    // 2) group が同じものは step 昇順
    // 3) 最後に qid 昇順で安定化
    pool.sort(function(a, b) {
      const keyA = a.group ? ('G:' + a.group) : ('Q:' + a.qidSort);
      const keyB = b.group ? ('G:' + b.group) : ('Q:' + b.qidSort);
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;

      const sa = (a.step == null) ? 0 : a.step;
      const sb = (b.step == null) ? 0 : b.step;
      if (sa !== sb) return sa - sb;

      // qid の安定化（数値→文字）
      if (a.qidSort < b.qidSort) return -1;
      if (a.qidSort > b.qidSort) return 1;

      return 0;
    });
  } else {
    // 既存どおりシャッフル
    shuffle_(pool);
  }

  return pool.slice(0, limit);
}


// ===== ログ書き込み（ロックで競合回避） =====
function logResponse(payload) {
  const { user_id, qid, chosen, correct, elapsed_ms, device, timestamp } = payload || {};
  mustAllow_(user_id); // 認可

  const ts = timestamp ? new Date(timestamp) : new Date(); // サーバ側で時刻確定
  ensureSheets_(); // ヘッダ保証

  // === 二重送信ガード（その1：キャッシュ 即時判定） ===
  var fp = makeDupKey_(user_id, qid, chosen);
  var cache = CacheService.getScriptCache();
  var hit = cache.get(fp);
  if (hit) {
    // 直前に同一キーを処理済み
    return { ok: true, deduped: true, via: 'cache' };
  }

  // 同時アクセス時の競合を回避（ScriptLock）
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const ss = SpreadsheetApp.openById(getSpreadsheetId_());
    const sh = ss.getSheetByName(SHEET_RESPONSES);
    if (!sh) throw new Error('Responses シートが見つかりません');

    // === 二重送信ガード（その2：シートの直近行を確認） ===
    const headerMap = findHeaderIndexMap_(sh, ['timestamp','user_id','qid','chosen']);
    if (hasRecentDuplicate_(sh, headerMap, user_id, qid, chosen, ts, /*ms*/ 5000, /*scanRows*/ 200)) {
      return { ok: true, deduped: true, via: 'sheet' };
    }

    // ここまで来たら新規として記録
    sh.appendRow([ts, user_id || '', qid || '', chosen || '', correct === true, elapsed_ms || '', device || '']);

    // キャッシュに鍵を 2秒 だけ置く（短時間の再送を抑止）
    cache.put(fp, '1', 2);

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}


// ===== 当日サマリー =====
function getTodaySummary(user_id) {
  mustAllow_(user_id); // 認可

  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  const sh = ss.getSheetByName(SHEET_RESPONSES);
  if (!sh) throw new Error('Responses シートが見つかりません');

  const data = sh.getDataRange().getValues();
  const header = data.shift();
  const idxTs = header.indexOf('timestamp');
  const idxUid = header.indexOf('user_id');
  const idxCorrect = header.indexOf('correct');
  if (idxTs === -1 || idxUid === -1 || idxCorrect === -1) throw new Error('Responses ヘッダが正しくありません');

  let done = 0, corrects = 0;
  data.forEach(r => {
    const ts = new Date(r[idxTs]);
    const dstr = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
    if (String(r[idxUid]) === String(user_id) && dstr === today) {
      done++;
      const v = String(r[idxCorrect]).toUpperCase();
      if (v === 'TRUE' || v === '1') corrects++;
    }
  });
  return { done, corrects, date: today };
}

// ===== 小ヘルパー =====
function shuffle_(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// === デュープ防止ヘルパ ===

// フィンガープリント（user_id + qid + chosen で一意キー）
function makeDupKey_(user_id, qid, chosen) {
  return ['dup', String(user_id||''), String(qid||''), String(chosen||'')].join('|');
}

// ヘッダ名→列インデックスのマップを作る
function findHeaderIndexMap_(sh, names) {
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  names.forEach(n => {
    const idx = header.indexOf(n);
    if (idx === -1) throw new Error('Responses header missing: ' + n);
    map[n] = idx;
  });
  return map;
}

// 直近 scanRows 行を後方から見て、windowMs 以内の完全一致があるか
function hasRecentDuplicate_(sh, map, user_id, qid, chosen, ts, windowMs, scanRows) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false; // データなし
  const startRow = Math.max(2, lastRow - (scanRows || 200) + 1);
  const numRows = (lastRow - startRow + 1);
  if (numRows <= 0) return false;

  const rng = sh.getRange(startRow, 1, numRows, sh.getLastColumn());
  const values = rng.getValues();

  const tNow = ts.getTime();
  const iTs = map.timestamp, iUid = map.user_id, iQid = map.qid, iChosen = map.chosen;

  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (String(row[iUid]) !== String(user_id)) continue;
    if (String(row[iQid]) !== String(qid)) continue;
    if (String(row[iChosen]) !== String(chosen)) continue;

    var t = row[iTs] instanceof Date ? row[iTs].getTime() : new Date(row[iTs]).getTime();
    if (isFinite(t) && (tNow - t) <= windowMs) return true;
    // これより古い一致は“直近”と見なさない → 探索続行
  }
  return false;
}


function getPixelOverlayToday(user_id) {
  mustAllow_(user_id);
  const tz = 'Asia/Tokyo';
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  const shQ = ss.getSheetByName(SHEET_QUESTIONS);
  const shR = ss.getSheetByName(SHEET_RESPONSES);
  if (!shQ || !shR) throw new Error('Questions/Responses シートが見つかりません');

  // Questions: qid -> 位置
  const qVals = shQ.getDataRange().getValues();
  const qHeader = qVals.shift();
  const idxQid = qHeader.indexOf('qid');
  if (idxQid === -1) throw new Error('Questions に qid 列がありません');
  const qids = qVals.map(r => String(r[idxQid] || '')).filter(Boolean).sort();
  const pos = {};
  qids.forEach((q, i) => { pos[q] = i; });

  // 240 マスのレベル配列（0=未着手, 1=今日やった）
  const cols = 16, rows = 15, total = cols * rows;
  const levels = Array(total).fill(0);

  // Responses: 今日そのユーザーが解いた qid を集計
  const rVals = shR.getDataRange().getValues();
  const rHeader = rVals.shift();
  const iUid = rHeader.indexOf('user_id');
  const iQid = rHeader.indexOf('qid');
  const iTs  = rHeader.indexOf('timestamp');
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');

  const tried = {};
  for (const r of rVals) {
    if (String(r[iUid]) !== String(user_id)) continue;
    const ts = r[iTs];
    const d  = (ts instanceof Date) ? ts : new Date(ts);
    const ymd = Utilities.formatDate(d, tz, 'yyyyMMdd');
    if (ymd !== todayStr) continue;
    const qid = String(r[iQid] || '');
    if (qid) tried[qid] = true;
  }

  Object.keys(tried).forEach(qid => {
    const p = pos[qid];
    if (p == null) return;
    if (p < total) levels[p] = 1; // 今日やった → 70%表示（フロントで反映）
  });

  return { ok: true, cols: 16, rows: 15, levels: levels };
}



