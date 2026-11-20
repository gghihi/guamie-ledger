// 分類規則管理 API（歷史紀錄 H4）
//  GET  /api/categories              讀取這本帳的分類規則（依優先順序）
//  PUT  /api/categories              整份更新（新增／修改／刪除／調整順序）；只影響之後新增的紀錄（F9）
//  POST /api/categories/recalculate  用目前規則重新分類這本帳的全部紀錄（只在使用者按下並確認後才呼叫）
// 權限：先驗證登入，再限定「我所屬的帳本」；兩個成員都可以修改。

import { requireUser } from './auth.js';
import { requireMyLedger } from './ledgers.js';
import { loadCategories, classify, normalize, OTHER } from './categories.js';
import { HttpError, json, readJson, newId, cleanText } from './util.js';

const MAX_CATEGORIES = 30;
const MAX_KEYWORDS = 60;
const MAX_NAME = 12;
const MAX_KEYWORD = 20;

const toPublic = (c) => ({ name: c.name, keywords: c.keywords, isOther: c.is_other });

/** GET /api/categories */
export async function getCategories(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const categories = await loadCategories(env, ledgerId);
  return json(request, env, { ok: true, categories: categories.map(toPublic) });
}

/**
 * 檢查並整理使用者送來的分類清單（不含「其他」；「其他」由系統固定放在最後）。
 * 回傳 [{ name, keywords }]，順序即優先順序。格式不對時丟出白話錯誤。
 */
export function validateCategories(input) {
  if (!Array.isArray(input)) throw new HttpError(400, '分類資料格式不正確', 'bad_categories');
  const list = input.filter((c) => !(c && (c.isOther || normalize(c.name) === normalize(OTHER))));
  if (list.length > MAX_CATEGORIES) throw new HttpError(400, `分類最多 ${MAX_CATEGORIES} 個`, 'too_many_categories');

  const seen = new Set();
  return list.map((c, i) => {
    const name = cleanText(c && c.name, 100);
    if (!name) throw new HttpError(400, `第 ${i + 1} 個分類沒有名稱`, 'bad_category_name');
    if (name.length > MAX_NAME) throw new HttpError(400, `分類名稱「${name}」太長了（最多 ${MAX_NAME} 個字）`, 'bad_category_name');
    const key = normalize(name);
    if (seen.has(key)) throw new HttpError(400, `分類名稱「${name}」重複了`, 'duplicate_category');
    seen.add(key);

    const raw = Array.isArray(c.keywords) ? c.keywords : String(c.keywords ?? '').split(/[、,，\n]/);
    const keywords = [];
    const kwSeen = new Set();
    for (const k of raw) {
      const kw = cleanText(k, 100);
      if (!kw) continue; // 空白關鍵字直接略過
      if (kw.length > MAX_KEYWORD) throw new HttpError(400, `關鍵字「${kw.slice(0, 10)}…」太長了（最多 ${MAX_KEYWORD} 個字）`, 'bad_keyword');
      if (kwSeen.has(normalize(kw))) continue; // 同一分類內重複的只留一個
      kwSeen.add(normalize(kw));
      keywords.push(kw);
    }
    if (keywords.length > MAX_KEYWORDS) throw new HttpError(400, `「${name}」的關鍵字最多 ${MAX_KEYWORDS} 個`, 'too_many_keywords');
    return { name, keywords };
  });
}

/** PUT /api/categories：body { categories: [{ name, keywords }] }（陣列順序＝優先順序） */
export async function updateCategories(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const body = await readJson(request);
  const list = validateCategories(body && body.categories);

  // 整份替換：先刪掉舊規則，再依新順序寫入；「其他」固定最後。一起成功或一起失敗。
  const statements = [env.DB.prepare('DELETE FROM ledger_categories WHERE ledger_id = ?').bind(ledgerId)];
  list.forEach((c, i) => {
    statements.push(
      env.DB.prepare('INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other) VALUES (?, ?, ?, ?, ?, 0)')
        .bind(newId(), ledgerId, c.name, JSON.stringify(c.keywords), i + 1),
    );
  });
  statements.push(
    env.DB.prepare("INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other) VALUES (?, ?, ?, '[]', 99, 1)")
      .bind(newId(), ledgerId, OTHER),
  );
  await env.DB.batch(statements);
  // 注意：這裡「不」改動任何既有紀錄的分類（F9）
  const categories = await loadCategories(env, ledgerId);
  return json(request, env, { ok: true, categories: categories.map(toPublic) });
}

/** POST /api/categories/recalculate：用目前規則重新分類這本帳的全部紀錄，回傳改了幾筆 */
export async function recalculateCategories(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const rules = await loadCategories(env, ledgerId);
  const { results } = await env.DB.prepare('SELECT id, item, category FROM loans WHERE ledger_id = ?').bind(ledgerId).all();

  const changes = [];
  for (const r of results) {
    const next = classify(r.item, rules);
    if (next !== r.category) changes.push({ id: r.id, from: r.category, to: next });
  }
  // 分批寫入（每批 50 筆），每批一起成功或一起失敗
  for (let i = 0; i < changes.length; i += 50) {
    await env.DB.batch(changes.slice(i, i + 50).map((c) =>
      env.DB.prepare('UPDATE loans SET category = ? WHERE id = ? AND ledger_id = ?').bind(c.to, c.id, ledgerId)));
  }
  return json(request, env, { ok: true, total: results.length, updated: changes.length });
}
