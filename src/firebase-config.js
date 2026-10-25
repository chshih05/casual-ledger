// Firebase 網頁設定：這些值是公開資訊，不是密碼或私密金鑰（Firebase 官方說明可以放在網頁程式中）。
// 真正保護資料的是 Firestore 安全規則（firestore.rules），只允許帳號本人讀寫。
// 改成 null 時，網頁只存在本機、不會連線到任何雲端服務。
const LEDGER_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyB9luKQLje2WuQNo92VwUJJRwD2OTEW3S8',
  authDomain: 'casual-ledger-e0b0d.firebaseapp.com',
  projectId: 'casual-ledger-e0b0d',
  appId: '1:826129146752:web:649ba336b4c7d55b2c5765',
};
