// 統一發送通知（網頁推播＋LINE）
// 第 7 階段先保留這個入口，記錄「應該通知誰、通知什麼」；
// 第 11 階段接上網頁推播、第 12 階段接上 LINE 後，這裡才會真的送出。

/**
 * 通知種類：
 *  new_pending     有新借款待確認（通知對方）
 *  rejected        被否定（通知記帳的人）
 *  resubmitted     修改後重送（通知對方）
 *  repay_pending   還款待確認（第 8 階段）
 *  repay_confirmed 還款已確認（第 8 階段）
 *  repay_declined  對方表示還沒收到還款（第 8 階段補充）
 */
export async function notify(env, { type, toUserId, loan }) {
  // 只記錄種類與對象，不記錄金額、項目等內容
  console.log('通知（尚未接上推播）：', type, toUserId, loan?.id);
}
