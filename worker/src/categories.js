// 項目分類：依關鍵字自動分類（免費、離線，不使用 AI）
// 規則：
//  1. 項目名稱與關鍵字都先「正規化」：全形轉半形、英文轉小寫、去頭尾空白
//  2. 依分類排序（sort_order 小的優先）逐一比對，項目名稱「包含」任一關鍵字就歸入該類
//  3. 都對應不到 → 「其他」

import { newId } from './util.js';

export const OTHER = '其他';

/** 初始分類清單（順序即衝突時的優先順序）；遷移檔 0005 也寫入同一份給既有帳本 */
export const DEFAULT_CATEGORIES = [
  { name: '餐飲', keywords: ['早餐', '午餐', '晚餐', '便當', '火鍋', '麵', '飯', '外送'] },
  { name: '飲料', keywords: ['咖啡', '奶茶', '飲料', '啤酒', '手搖', '可樂', '茶'] },
  { name: '零食甜點', keywords: ['零食', '甜點', '蛋糕', '冰淇淋', '餅乾', '巧克力'] },
  { name: '購物', keywords: ['超市', '日用品', '衣服', '鞋子', '網購', '蝦皮'] },
  { name: '交通', keywords: ['捷運', '公車', '計程車', '油錢', '停車', '高鐵', '加油'] },
  { name: '娛樂', keywords: ['電影', '遊戲', 'KTV', '門票', '訂閱', '演唱會'] },
  { name: '居家', keywords: ['房租', '水電', '瓦斯', '網路', '電話', '修繕'] },
  { name: '醫療', keywords: ['看診', '藥', '掛號', '保健'] },
];

/** 正規化：ＫＴＶ → ktv、全形空白 → 半形、去頭尾空白 */
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().trim();
}

/**
 * 依規則分類一個項目名稱。
 * categories：[{ name, keywords: [...], sort_order?, is_other? }]（順序以 sort_order 為準；沒有就照陣列順序）
 */
export function classify(item, categories) {
  const text = normalize(item);
  if (!text) return OTHER;
  const ordered = [...categories]
    .map((c, i) => ({ ...c, _order: Number.isFinite(c.sort_order) ? c.sort_order : i }))
    .filter((c) => !c.is_other)
    .sort((a, b) => a._order - b._order);
  for (const c of ordered) {
    const hit = (c.keywords || []).some((k) => {
      const kw = normalize(k);
      return kw && text.includes(kw);
    });
    if (hit) return c.name;
  }
  return OTHER;
}

/** 讀取某本帳的分類規則（依優先順序）；還沒有規則的帳本會自動補上初始清單 */
export async function loadCategories(env, ledgerId) {
  let { results } = await env.DB.prepare(
    'SELECT id, name, keywords, sort_order, is_other FROM ledger_categories WHERE ledger_id = ? ORDER BY sort_order, name',
  ).bind(ledgerId).all();
  if (!results.length) {
    await seedDefaultCategories(env, ledgerId);
    ({ results } = await env.DB.prepare(
      'SELECT id, name, keywords, sort_order, is_other FROM ledger_categories WHERE ledger_id = ? ORDER BY sort_order, name',
    ).bind(ledgerId).all());
  }
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    keywords: safeParseList(r.keywords),
    sort_order: r.sort_order,
    is_other: Boolean(r.is_other),
  }));
}

/** 建立小窩時寫入初始分類 */
export function seedStatements(env, ledgerId) {
  const rows = DEFAULT_CATEGORIES.map((c, i) => [c.name, JSON.stringify(c.keywords), i + 1, 0]);
  rows.push([OTHER, '[]', 99, 1]);
  return rows.map(([name, keywords, order, isOther]) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(newId(), ledgerId, name, keywords, order, isOther),
  );
}

export async function seedDefaultCategories(env, ledgerId) {
  await env.DB.batch(seedStatements(env, ledgerId));
}

/** 依這本帳目前的規則，分類一個項目 */
export async function classifyForLedger(env, ledgerId, item) {
  return classify(item, await loadCategories(env, ledgerId));
}

function safeParseList(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
