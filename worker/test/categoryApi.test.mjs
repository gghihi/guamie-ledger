// 分類規則檢查的自動測試（歷史紀錄 H4）
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCategories } from '../src/categoryApi.js';

const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

test('整理分類：去空白、略過空白與重複關鍵字、保留順序', () => {
  const out = validateCategories([
    { name: ' 餐飲 ', keywords: ['早餐', ' ', '早餐', '午餐'] },
    { name: '飲料', keywords: '咖啡、奶茶,茶' },
  ]);
  assert.deepEqual(out, [
    { name: '餐飲', keywords: ['早餐', '午餐'] },
    { name: '飲料', keywords: ['咖啡', '奶茶', '茶'] },
  ]);
});

test('「其他」由系統固定處理：使用者送來的「其他」會被略過', () => {
  const out = validateCategories([{ name: '餐飲', keywords: [] }, { name: '其他', keywords: ['亂加'] }, { name: 'x', isOther: true }]);
  assert.deepEqual(out.map((c) => c.name), ['餐飲']);
});

test('分類名稱不能空白、不能重複（不分全形半形大小寫）、不能太長', () => {
  throwsMsg(() => validateCategories([{ name: ' ', keywords: [] }]), /沒有名稱/);
  throwsMsg(() => validateCategories([{ name: 'KTV', keywords: [] }, { name: 'ｋｔｖ', keywords: [] }]), /重複/);
  throwsMsg(() => validateCategories([{ name: '一二三四五六七八九十一二三', keywords: [] }]), /太長/);
});

test('關鍵字太長會被拒絕；格式錯誤會被拒絕', () => {
  throwsMsg(() => validateCategories([{ name: 'a', keywords: ['x'.repeat(21)] }]), /太長/);
  throwsMsg(() => validateCategories('not-array'), /格式不正確/);
});
