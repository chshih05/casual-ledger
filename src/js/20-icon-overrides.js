// A consistent, rounded outline set with concrete category silhouettes.
const outlineIcon = body => `<svg class="w-5 h-5 category-icon" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${body}</svg>`;
Object.assign(ICONS, {
  breakfast: outlineIcon('<path d="M3 9h12v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9Z M15 10h2a3 3 0 0 1 0 6h-2 M6 3v2 M10 2v3"/>'),
  lunch: outlineIcon('<path d="M3 12h18c0 5-3 8-9 8s-9-3-9-8Z M8 20v1h8v-1 M7 8l10-5 M11 9l10-5"/>'),
  dinner: outlineIcon('<path d="M5 3v5a3 3 0 0 0 6 0V3 M8 3v18 M17 3c-2 3-2 7-2 10h4 M19 3v18"/>'),
  drink: outlineIcon('<path d="M5 7h14 M6 7l2 14h8l2-14 M12 7l2-5h5 M8 12h8"/>'),
  daily: outlineIcon('<ellipse cx="8" cy="7" rx="5" ry="4"/><ellipse cx="8" cy="7" rx="1.5" ry="1"/><path d="M3 7v10c0 2.2 2.2 4 5 4h11V7H13 M13 7v10 M16 11h1 M16 15h1"/>'),
  transport: outlineIcon('<rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14 M9 3v8 M15 3v8 M8 19l-2 3 M16 19l2 3"/><circle cx="9" cy="15" r=".8"/><circle cx="15" cy="15" r=".8"/>'),
  bills: outlineIcon('<path d="M6 3h12v19l-3-2-3 2-3-2-3 2V3Z M9 7h6 M9 11h6 M9 15h3"/>'),
  medical: outlineIcon('<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M12 10v7 M8.5 13.5h7"/>'),
  entertainment: outlineIcon('<path d="M7 7h10c2 0 3 2 3.5 4l1 6c.5 3-2 4-4 2l-2-2h-7l-2 2c-2 2-4.5 1-4-2l1-6C4 9 5 7 7 7Z M7 10v5 M4.5 12.5h5"/><circle cx="16" cy="11" r=".8"/><circle cx="18" cy="14" r=".8"/>'),
  home: outlineIcon('<path d="M3 11l9-8 9 8 M5 10v11h14V10 M10 21v-7h4v7"/>'),
  clothing: outlineIcon('<path d="M8 3l-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z"/>'),
  book: outlineIcon('<path d="M12 6v15 M12 6C9 4 6 3 3 4v15c3-1 6 0 9 2 3-2 6-3 9-2V4c-3-1-6 0-9 2Z"/>'),
  phone: outlineIcon('<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4 M11 19h2"/>'),
  pet: outlineIcon('<ellipse cx="5" cy="9" rx="2" ry="2.5"/><ellipse cx="10" cy="5" rx="2" ry="2.5"/><ellipse cx="16" cy="5" rx="2" ry="2.5"/><ellipse cx="20" cy="10" rx="2" ry="2.5"/><path d="M6 18c0-2 4-7 6-7s6 5 6 7-2 3-3 3l-3-1-3 1c-2 0-3-1-3-3Z"/>'),
  travel: outlineIcon('<rect x="5" y="6" width="14" height="15" rx="3"/><path d="M9 6V3h6v3 M9 10v7 M15 10v7 M8 21v1 M16 21v1"/>'),
  fitness: outlineIcon('<path d="M3 9v6 M6 6v12 M18 6v12 M21 9v6 M6 12h12 M3 12H1 M23 12h-2"/>'),
  cart: outlineIcon('<path d="M2 3h3l3 13h11l3-9H6 M9 11h10"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>'),
  cut: outlineIcon('<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8 9l12 12 M8 15L20 3 M12 12l2-2"/>'),
  repair: outlineIcon('<path d="M21 4l-4 4-3-3 4-4a6 6 0 0 0-7 8L3 17a3 3 0 0 0 4 4l8-8a6 6 0 0 0 6-9Z"/>'),
  salary: outlineIcon('<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8V5a2 2 0 0 1 2-2h12 M21 10h-6v6h6"/><circle cx="17" cy="13" r=".7"/>'),
  bonus: outlineIcon('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9 M12 8v13 M12 8H8a3 3 0 1 1 3-3l1 3Z M12 8h4a3 3 0 1 0-3-3l-1 3Z"/>'),
  bank: outlineIcon('<path d="M2 8l10-6 10 6H2Z M5 11v7 M10 11v7 M14 11v7 M19 11v7 M3 21h18"/>'),
  star: outlineIcon('<path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z"/>'),
  other: outlineIcon('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>')
});
Object.assign(ICON_LABELS, {breakfast:'早餐咖啡',lunch:'午餐碗筷',dinner:'晚餐餐具',daily:'日用紙品',transport:'交通列車',bills:'固定帳單',entertainment:'娛樂遊戲',medical:'醫療保健',salary:'薪資錢包',pet:'寵物腳印',travel:'旅遊行李',repair:'維修工具'});

