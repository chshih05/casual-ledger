// Firebase 網頁設定：這些值是公開資訊，不是密碼或私密金鑰（Firebase 官方說明可以放在網頁程式中）。
// 真正保護資料的是 Firestore 安全規則（firestore.rules），只允許帳號本人讀寫。
// 建立 Firebase 專案並新增「網頁應用程式」後，把主控台顯示的 firebaseConfig 填在下方，
// 再執行 python tools/build.py。保持 null 時，網頁只存在本機、不會連線到任何雲端服務。
const LEDGER_FIREBASE_CONFIG = null;
/* 填寫範例（請換成你自己的值）：
const LEDGER_FIREBASE_CONFIG = {
  apiKey: '主控台中的 apiKey',
  authDomain: '你的專案代碼.firebaseapp.com',
  projectId: '你的專案代碼',
  appId: '主控台中的 appId',
};
*/
