(() => {
  const DAY = 86400000;
  const DEMO_NOW = new Date("2026-07-13T12:00:00+08:00");
  const BALANCE_KEY = "colearnx-point-balance";
  const POINT_ORDERS_KEY = "colearnx-point-orders";
  const DRAFT_KEY = "colearnx-course-draft-v3";
  const ACTIVE_ROLE_KEY = "colearnx-active-role-v1";

  const courses = {
    "ai-basics": {
      title: "AI Basics Training Course", trainer: "Trainer A", category: "AI", price: 80,
      purchased: false, mode: "offline", access: "external", duration: "45 min",
      structure: "single",
      sessions: [{ topic: "AI foundations and prompt practice", duration: "45 min" }]
    },
    "web-design": {
      title: "Web Design Bootcamp", trainer: "Trainer B", category: "Design", price: 120,
      purchased: true, purchasedAt: "2026-07-13T09:00:00+08:00", mode: "offline", access: "external", duration: "3 hr",
      structure: "series",
      sessions: [
        { topic: "Layout foundations", duration: "45 min", status: "Completed" },
        { topic: "Typography and colour", duration: "45 min", status: "Next" },
        { topic: "Responsive design", duration: "45 min", status: "Upcoming" },
        { topic: "Portfolio critique", duration: "45 min", status: "Upcoming" }
      ]
    },
    cybersecurity: {
      title: "Cybersecurity Intro", trainer: "Trainer C", category: "Security", price: 100,
      purchased: true, mode: "online", delivery: "live", replay: false, duration: "1 hr", total: 60,
      structure: "single", startsAt: "2026-08-03T20:00:00+08:00",
      sessions: [{ topic: "Live cybersecurity essentials", date: "03 Aug 2026", time: "20:00-21:00", duration: "60 min", location: "Zoom" }]
    },
    "javascript-starter": {
      title: "JavaScript Starter", trainer: "Trainer D", category: "Code", price: 70,
      purchased: true, mode: "online", delivery: "live", replay: true, duration: "2 hr", total: 120,
      structure: "series", startsAt: "2026-08-15T09:00:00+08:00",
      sessions: [
        { topic: "Variables and data types", date: "15 Aug 2026", time: "09:00-09:30", duration: "30 min", location: "Microsoft Teams", status: "External replay possible" },
        { topic: "Functions", date: "17 Aug 2026", time: "09:00-09:30", duration: "30 min", location: "Microsoft Teams", status: "External replay possible" },
        { topic: "Arrays and objects", date: "19 Aug 2026", time: "09:00-09:30", duration: "30 min", location: "Microsoft Teams", status: "External replay possible" },
        { topic: "Browser project", date: "21 Aug 2026", time: "09:00-09:30", duration: "30 min", location: "Microsoft Teams", status: "External replay possible" }
      ]
    }
  };
  const ids = Object.keys(courses);
  const editorState = {
    mode: "online", hasReplay: true, offlineType: "single", access: "external", sessions: 3,
    provider: "Zoom", startsAt: "2026-08-03T20:00", timezone: "Asia/Singapore", onlineDuration: "2 hr",
    offlineDurations: { single: "45 min", series: "3 hr" },
    moduleTitles: ["Module 1: Foundations", "Module 2: Guided practice", "Module 3: Final project"]
  };
  const pointPlans = [
    { id: "starter", points: 100, price: 9.9, bonus: 0, tag: "For quick trials" },
    { id: "popular", points: 320, price: 29.9, bonus: 20, tag: "Most popular" },
    { id: "pro", points: 680, price: 59.9, bonus: 80, tag: "Best value" }
  ];
  const sellerLedger = [
    { date: "13 Jul 2026", seller: "Trainer B", item: "Web Design Bootcamp", buyer: "Member", points: 120, state: "Frozen", trigger: "Awaiting refund window / first access" },
    { date: "13 Jul 2026", seller: "Trainer C", item: "Cybersecurity Intro", buyer: "Member", points: 100, state: "Frozen", trigger: "Live course not started" },
    { date: "12 Jul 2026", seller: "Creator B", item: "Pixel Art Guide", buyer: "Member", points: 42, state: "Released", trigger: "First file access completed" },
    { date: "11 Jul 2026", seller: "Trainer A", item: "AI Basics Training Course", buyer: "Member", points: 80, state: "Refunded", trigger: "Refund approved; points returned to buyer" }
  ];
  const paymentChannels = [
    { channel: "Credit / Debit Card", status: "Active", settlement: "External payment only for point top-up" },
    { channel: "PayNow", status: "Active", settlement: "QR confirmation before points are issued" },
    { channel: "Apple Pay / Google Pay", status: "Active", settlement: "Wallet checkout for point top-up" }
  ];
  const abnormalRefunds = [
    { id: "AR-1042", case: "Card chargeback after points issued", action: "Freeze equivalent points and review" },
    { id: "AR-1043", case: "Payment timeout but provider later confirms paid", action: "Reconcile and issue missing points" },
    { id: "AR-1044", case: "Duplicate top-up order", action: "Refund external payment or void duplicate points" }
  ];
  const baseTransactions = [
    { id: "TX-0716-01", date: "16 Jul 2026", description: "Course purchase", details: "Cybersecurity Intro", category: "spending", amount: -90, balance: 320, status: "Completed" },
    { id: "TX-0715-01", date: "15 Jul 2026", description: "Points top-up", details: "Credit / Debit Card", category: "topup", amount: 100, balance: 410, status: "Completed" },
    { id: "TX-0714-01", date: "14 Jul 2026", description: "Trainer income", details: "Web Design Bootcamp", category: "income", amount: 120, balance: 310, status: "Released" },
    { id: "TX-0713-01", date: "13 Jul 2026", description: "Course refund", details: "Cybersecurity Intro", category: "refund", amount: 100, balance: 190, status: "Approved" },
    { id: "TX-0712-01", date: "12 Jul 2026", description: "Content purchase", details: "AI Study Notes", category: "spending", amount: -30, balance: 90, status: "Completed" },
    { id: "TX-0711-01", date: "11 Jul 2026", description: "Course purchase", details: "AI Basics Training Course", category: "spending", amount: -80, balance: 120, status: "Completed" },
    { id: "TX-0710-01", date: "10 Jul 2026", description: "Points top-up", details: "PayNow", category: "topup", amount: 200, balance: 200, status: "Completed" }
  ];

  const icon = (name, size = 18) => {
    const paths = {
      home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
      library: '<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/><path d="M2 20h20"/>',
      cart: '<circle cx="9" cy="20" r="1"/><circle cx="19" cy="20" r="1"/><path d="M3 4h2l2.4 10.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.7L20.5 8H6"/>',
      receipt: '<path d="M4 2v20l3-2 3 2 2-2 3 2 2-2 3 2V2l-3 2-3-2-2 2-3-2-2 2Z"/><path d="M16 8h-6M16 12h-6M13 16h-3"/>',
      wallet: '<path d="M20 7V6a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v10H5a3 3 0 0 1-3-3V7"/><path d="M16 14h.01"/>',
      history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
      plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
      badge: '<path d="M12 3 9.5 5.5 6 5l-.5 3.5L3 11l2.5 2.5L6 17l3.5-.5L12 19l2.5-2.5L18 17l.5-3.5L21 11l-2.5-2.5L18 5l-3.5.5Z"/><path d="m9.5 11 1.7 1.7 3.5-3.5"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      play: '<path d="m8 5 11 7-11 7z"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
      sparkles: '<path d="m12 3-1.1 3.4L7.5 7.5l3.4 1.1L12 12l1.1-3.4 3.4-1.1-3.4-1.1Z"/><path d="m19 14-.7 2.3L16 17l2.3.7L19 20l.7-2.3L22 17l-2.3-.7Z"/><path d="m5 13-.7 2.3L2 16l2.3.7L5 19l.7-2.3L8 16l-2.3-.7Z"/>',
      download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8M22 21v-2a4 4 0 0 0-3-3.87"/>',
      grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
      arrowLeft: '<path d="m15 18-6-6 6-6M9 12h10"/>',
      external: '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
      card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
      circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>'
    };
    return `<svg class="cx-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.check}</svg>`;
  };
  const escapeAttr = value => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const styles = `
    .cx-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 18px;flex-wrap:wrap}.cx-filter-stack{display:flex;gap:13px;flex-wrap:wrap;align-items:flex-end}.cx-filter-block label{display:block;color:#667085;font-size:11px;font-weight:800;letter-spacing:.04em;margin-bottom:6px;text-transform:uppercase}.cx-filter-group{display:flex;gap:6px;flex-wrap:wrap}.cx-filter{border:1px solid #dce2ef;background:#fff;color:#586174;min-height:34px;padding:0 12px;border-radius:999px;font-size:12px}.cx-filter.active{border-color:#3857f6;background:#eef1ff;color:#263db7}.cx-muted{color:#667085;font-size:13px}
    .cx-badge{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;border-radius:999px;padding:5px 9px;background:#f1f4f9;color:#526074;font-size:12px;font-weight:800}.cx-badge.replay{background:#f1ebff;color:#6d3fc0}.cx-badge.live{background:#fff0f0;color:#c03b49}.cx-badge.owned{background:#e9f8ef;color:#147a43}.cx-badge.series{background:#fff6df;color:#936300}.cx-badge.offline{background:#eaf6ff;color:#176a9c}.cx-badge.danger{background:#fff0f0;color:#b42318}
    .cx-course-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.cx-course-card{background:#fff;border:1px solid #e1e6f0;border-radius:14px;overflow:hidden;box-shadow:0 12px 32px #2a31480c;transition:.18s ease}.cx-course-card:hover{transform:translateY(-2px);box-shadow:0 18px 42px #2a314817}.cx-cover{height:132px;padding:18px;display:flex;justify-content:space-between;align-items:flex-start;background:linear-gradient(135deg,#273bb2,#6d5dfc);color:#fff}.cx-cover.design{background:linear-gradient(135deg,#7b2cbf,#d16ba5)}.cx-cover.security{background:linear-gradient(135deg,#075985,#0891b2)}.cx-cover.code{background:linear-gradient(135deg,#111827,#374151)}.cx-cover-mark{font-size:35px;font-weight:900;opacity:.92}.cx-card-body{padding:19px}.cx-card-body h3{font-size:19px;margin:0 0 5px}.cx-trainer{color:#667085;font-size:13px}.cx-card-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:16px 0}.cx-meta{display:flex;gap:7px;align-items:center;color:#586174;font-size:13px}.cx-card-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid #edf0f6;padding-top:15px}.cx-price{font-size:20px;font-weight:900;color:#263db7}.cx-empty{display:none;text-align:center;background:#fff;border:1px dashed #bcc5d6;border-radius:14px;padding:55px 20px}.cx-empty.show{display:block}.cx-empty strong{display:block;font-size:18px;margin-bottom:6px}
    .cx-progress{min-width:140px}.cx-progress-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:7px;color:#667085;font-size:12px}.cx-track{height:7px;background:#e7ebf3;border-radius:999px;overflow:hidden}.cx-track span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#3857f6,#7c5cff)}.cx-progress-card{margin-top:14px;padding-top:14px;border-top:1px solid #dce2ef}.cx-owned-box strong{font-size:20px!important;color:#15803d!important}.cx-owned-box .cx-badge{margin-bottom:10px}.cx-date-note{min-width:170px;color:#667085;font-size:12px;line-height:1.45}.cx-date-note strong{display:block;color:#172033;font-size:13px;margin-bottom:3px}.cx-refund-note{min-width:150px}.cx-refund-note small{display:block;color:#667085;margin-top:5px;line-height:1.35}.cx-status-list{display:grid;gap:7px;margin-top:12px;text-align:left}.cx-status-list span{color:#667085;font-size:12px}.cx-status-list b{display:block;color:#172033;font-size:13px}
    .cx-schedule{margin-top:18px}.cx-schedule-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.cx-schedule h3{margin:0}.cx-series-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0 18px}.cx-series-stat{background:#f6f8fc;border-radius:9px;padding:12px}.cx-series-stat strong{display:block;font-size:17px}.cx-series-stat span{color:#667085;font-size:12px}.cx-session{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:start;padding:14px 0;border-top:1px solid #edf0f6}.cx-session svg{color:#3857f6;margin-top:2px}.cx-session strong{display:block}.cx-session span{display:block;color:#667085;font-size:13px;margin-top:3px}.cx-session-time{text-align:right;color:#526074;font-size:12px;white-space:nowrap}
    .cx-rule{margin-top:18px;border-radius:12px;padding:17px;border:1px solid #dce2ef;background:#fff}.cx-rule.eligible{border-color:#9dd9b6;background:#f2fbf6}.cx-rule.ineligible{border-color:#efb2b2;background:#fff7f7}.cx-rule h3{margin:0 0 7px}.cx-rule p{margin:4px 0}.cx-warning{display:flex;gap:10px;background:#fff8e6;border:1px solid #f5d38b;border-radius:9px;color:#7a4d00;padding:12px;margin-top:12px;font-size:13px}
    .cx-modal-backdrop{position:fixed;inset:0;background:#17203380;z-index:40;display:grid;place-items:center;padding:20px}.cx-modal{background:#fff;border-radius:14px;box-shadow:0 24px 80px #1720334d;max-width:620px;width:100%;padding:24px}.cx-modal h2{margin-bottom:8px}.cx-modal .actions{justify-content:flex-end}.cx-preview-list{background:#f6f8fc;border-radius:10px;padding:14px;margin:14px 0}.cx-preview-list p{margin:6px 0}
    .cx-editor-section{border:1px solid #e1e6f0;border-radius:10px;background:#fafbfe;padding:18px}.cx-section-heading{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}.cx-section-heading h3{margin:0 0 4px}.cx-section-heading p{margin:0;font-size:13px}.cx-segmented{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.cx-option{border:1px solid #dce2ef;background:#fff;min-height:72px;padding:12px;text-align:left;display:block}.cx-option strong,.cx-option span{display:block}.cx-option span{font-size:12px;color:#667085;margin-top:3px;font-weight:500}.cx-option.active{border:2px solid #3857f6;background:#eef1ff;color:#263db7}
    .cx-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.cx-field label{display:block;color:#596579;font-size:12px;font-weight:800;margin-bottom:6px}.cx-field input,.cx-field select{width:100%;min-height:44px;margin:0!important;border:1px solid #dce2ef;border-radius:8px;background:#fff;padding:10px 12px}.cx-field .invalid{border-color:#d92d20;background:#fff7f7}.cx-error{display:block;color:#b42318;font-size:12px;margin-top:5px}.cx-series-list{display:flex;flex-direction:column;gap:9px;margin-top:14px}.cx-series-row{display:grid;grid-template-columns:32px 28px minmax(0,1fr) 180px 32px;gap:8px;align-items:center;background:#fff;border:1px solid #e5e9f1;border-radius:9px;padding:8px}.cx-grip{color:#98a2b3;cursor:grab}.cx-series-row b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#eef1ff;color:#3857f6;font-size:12px}.cx-icon-btn{border:0;background:#f3f5fa;color:#596579;min-height:30px;width:30px;padding:0}.cx-add-session{align-self:flex-start;margin-top:10px}.cx-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:13px;color:#667085;font-size:13px}.cx-autosave{display:flex;align-items:center;gap:7px;color:#667085;font-size:12px;margin-left:auto}.cx-validation{display:none;background:#fff0f0;border:1px solid #efb2b2;border-radius:9px;color:#9f1d1d;padding:12px}.cx-validation.show{display:block}
    .tabs{flex-wrap:wrap}.tabs button.active{background:#3857f6;color:#fff}.cx-purchases-page .grid.two{grid-template-columns:1fr}.cx-purchases-page .table-card{overflow-x:auto}.cx-purchases-page .table-card table{min-width:940px}.cx-purchases-page .table-card th:last-child,.cx-purchases-page .table-card td:last-child{width:120px;text-align:right}.cx-purchases-page .table-card .mini{white-space:nowrap}.cx-toast{position:fixed;right:24px;bottom:24px;z-index:60;background:#172033;color:#fff;padding:14px 18px;border-radius:10px;box-shadow:0 14px 40px #17203338;font-weight:700;animation:cx-in .2s ease}@keyframes cx-in{from{opacity:0;transform:translateY(8px)}}
    .cx-topup-hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:18px;margin-bottom:18px}.cx-topup-card,.cx-payment-card{background:#fff;border:1px solid #e4e7ef;border-radius:12px;box-shadow:0 16px 40px #2a31480f;padding:22px}.cx-topup-card h2,.cx-payment-card h3{margin:0 0 8px}.cx-stepper{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 18px}.cx-step{background:#fff;border:1px solid #e4e7ef;border-radius:12px;padding:12px;color:#667085}.cx-step b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#eef1ff;color:#2b41c3;margin-bottom:6px}.cx-step.active{border:2px solid #3857f6;color:#172033;background:#f5f7ff}.cx-step.done b{background:#16a34a;color:#fff}.cx-plan-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0}.cx-plan{border:1px solid #dce2ef;background:#fff;border-radius:12px;padding:18px;text-align:left;cursor:pointer}.cx-plan:hover,.cx-plan.active{border:2px solid #3857f6;background:#f5f7ff}.cx-plan strong{display:block;font-size:30px}.cx-plan small{color:#667085}.cx-plan .price{color:#263db7;font-weight:900;margin-top:12px}.cx-pay-methods{display:grid;gap:12px;margin:14px 0}.cx-method{border:1px solid #dce2ef;border-radius:12px;padding:16px;display:flex;justify-content:space-between;gap:12px;align-items:center;cursor:pointer;background:#fff}.cx-method strong{display:block}.cx-method small{color:#667085}.cx-method.active,.cx-method:hover{border:2px solid #3857f6;background:#f5f7ff}.cx-payment-form{display:grid;gap:12px;margin-top:14px}.cx-payment-form label{display:block;color:#596579;font-size:12px;font-weight:800}.cx-payment-form input{width:100%;min-height:44px;margin-top:6px;border:1px solid #dce2ef;border-radius:8px;padding:10px 12px}.cx-form-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cx-summary-row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #edf0f6;padding:11px 0}.cx-summary-row.total{font-size:18px;font-weight:900;color:#172033}.cx-safe{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:10px;padding:12px;margin-top:14px}.cx-wallet-cta{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:0 0 18px;padding:18px;background:#fff;border:1px solid #e4e7ef;border-radius:12px;box-shadow:0 16px 40px #2a31480f}.cx-wallet-cta h3{margin:0 0 4px}.cx-success-box{background:#fff;border:1px solid #e4e7ef;border-radius:12px;box-shadow:0 16px 40px #2a31480f;padding:50px 24px;text-align:center;max-width:720px;margin:40px auto}.cx-success-box strong{font-size:34px;color:#16a34a}.cx-wide{width:100%}
    body{background:radial-gradient(circle at 82% 8%,#e8edff 0,#f7f8fc 34%,#f8fafc 100%)}main{background:linear-gradient(180deg,#f7f8ff,#f8fafc);min-height:100vh}.sidebar{box-shadow:10px 0 30px #17203308}.sidebar nav a.active{background:linear-gradient(135deg,#3857f6,#6d5dfc)!important;color:#fff!important;box-shadow:0 10px 24px #3857f633}.topbar{background:rgba(255,255,255,.78);backdrop-filter:blur(12px);border:1px solid #e8ecf5;border-radius:18px;padding:18px 20px;box-shadow:0 18px 50px #1720330d}.topbar h1{letter-spacing:-.04em}.status-pill{box-shadow:0 10px 24px #3857f61c}.panel,.table-card,.feature-card,.metric,.detail-hero,.profile-hero{border-radius:16px!important;border-color:#e8ecf5!important;box-shadow:0 20px 60px #1720330d!important}button,.primary,.secondary,.ghost,.mini{border-radius:11px!important}.primary{background:linear-gradient(135deg,#3857f6,#6d5dfc)!important;box-shadow:0 12px 24px #3857f626}.secondary{background:#eef2ff!important}.cx-hero-banner{position:relative;overflow:hidden;background:linear-gradient(135deg,#172033,#3857f6 58%,#8b5cf6);border-radius:22px;color:#fff;padding:28px;margin-bottom:18px;box-shadow:0 24px 80px #3857f633}.cx-hero-banner:after{content:"";position:absolute;right:-70px;top:-80px;width:260px;height:260px;border-radius:50%;background:#ffffff22}.cx-hero-banner h2{font-size:30px;margin:0 0 8px;letter-spacing:-.04em}.cx-hero-banner p{max-width:760px;color:#e5eaff;margin:0}.cx-rule-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}.cx-rule-tile{background:#ffffff17;border:1px solid #ffffff30;border-radius:16px;padding:15px}.cx-rule-tile b{display:block;color:#fff;font-size:15px}.cx-rule-tile span{display:block;color:#dbe4ff;font-size:12px;margin-top:4px}.cx-info-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0}.cx-info-card{background:#fff;border:1px solid #e8ecf5;border-radius:16px;padding:18px;box-shadow:0 16px 45px #1720330b}.cx-info-card h3{margin:0 0 6px}.cx-info-card strong{font-size:24px}.cx-ledger{background:#fff;border:1px solid #e8ecf5;border-radius:16px;box-shadow:0 16px 45px #1720330b;overflow:hidden;margin-top:18px}.cx-ledger h3{padding:18px;margin:0}.cx-ledger table{width:100%}.cx-status-frozen{color:#a16207;font-weight:900}.cx-status-released{color:#15803d;font-weight:900}.cx-status-refunded{color:#b42318;font-weight:900}.cx-economy-note{display:grid;grid-template-columns:42px minmax(0,1fr);gap:12px;align-items:start;background:#f5f7ff;border:1px solid #dfe6ff;border-radius:14px;padding:14px;margin-top:14px}.cx-economy-note b{display:block;color:#172033}.cx-economy-note span{color:#667085;font-size:13px}.cx-pill-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.cx-pill{border-radius:999px;background:#eef2ff;color:#2b41c3;font-weight:800;font-size:12px;padding:7px 10px}.cx-payment-card.sticky{position:sticky;top:18px}.cx-plan.active{box-shadow:0 18px 40px #3857f61f}.cx-method.active{box-shadow:0 18px 40px #3857f61a}.cx-qrcode{width:154px;height:154px;margin:16px auto;background:conic-gradient(from 90deg,#111827 0 25%,#fff 0 50%,#111827 0 75%,#fff 0);background-size:22px 22px;border:12px solid #fff;box-shadow:0 0 0 1px #dce2ef,0 14px 34px #1720331a}
    .cx-plan{display:block;min-height:156px}.cx-plan .cx-badge{margin-bottom:12px}.cx-plan strong{line-height:1.1;margin-bottom:6px}.cx-plan small,.cx-plan .price{display:block}.cx-economy-note{grid-template-columns:minmax(100px,max-content) minmax(0,1fr)}.cx-economy-note .cx-badge{justify-self:start}
    .cx-brand-lockup{display:block!important;min-height:92px!important;padding:0!important;border-radius:14px!important;overflow:hidden;background:#fff!important}.cx-brand-lockup img{display:block;width:100%;max-width:190px;height:auto;mix-blend-mode:multiply}.cx-brand-product{display:block;color:#596579!important;font-size:10px;font-weight:800;letter-spacing:.08em;margin-top:4px;text-transform:uppercase}.auth-brand.cx-brand-lockup{max-width:270px;margin:0 auto 18px}.auth-brand.cx-brand-lockup img{max-width:270px}.sidebar nav a{gap:11px!important}.sidebar nav a.cx-role-hidden{display:none!important}.sidebar nav a .cx-nav-icon{display:grid;place-items:center;flex:0 0 22px;color:#768196}.sidebar nav a.active .cx-nav-icon,.sidebar nav a:hover .cx-nav-icon{color:currentColor}.sidebar nav a .cx-nav-label{min-width:0}.cx-sidebar-context{margin-top:auto;display:flex;align-items:center;gap:10px;border:1px solid #e4e8f1;border-radius:13px;padding:12px;background:#f8faff;color:#526074}.cx-sidebar-context svg{color:#3857f6}.cx-sidebar-context b,.cx-sidebar-context span{display:block}.cx-sidebar-context b{font-size:12px}.cx-sidebar-context span{font-size:11px;color:#7a8496}
    .cx-wallet-page{display:grid;gap:18px}.cx-wallet-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:center;border-radius:22px;padding:30px;background:linear-gradient(135deg,#18213f 0%,#354fc4 56%,#7c3aed 100%);color:#fff;box-shadow:0 24px 70px #3857f62c}.cx-wallet-hero:after{content:"";position:absolute;right:-70px;top:-110px;width:290px;height:290px;border-radius:50%;background:#ffffff14}.cx-wallet-balance{position:relative;z-index:1}.cx-wallet-kicker{display:flex;align-items:center;gap:8px;color:#dfe5ff;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.cx-wallet-balance strong{display:block;font-size:54px;line-height:1;margin:12px 0 10px;letter-spacing:-.05em}.cx-wallet-balance p{color:#dfe5ff;margin:0;max-width:560px}.cx-wallet-actions{position:relative;z-index:1;display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}.cx-wallet-actions .primary{background:#fff!important;color:#293ba8!important;box-shadow:0 14px 32px #1118272e!important}.cx-wallet-actions .secondary{background:#ffffff18!important;color:#fff!important;border:1px solid #ffffff42}.cx-wallet-note{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;border:1px solid #e5e9f2;border-radius:16px;background:#fff;padding:20px;box-shadow:0 16px 45px #1720330b}.cx-wallet-note-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#eef2ff;color:#3857f6}.cx-wallet-note h3{margin:0 0 6px}.cx-wallet-note p{margin:0;color:#667085}.cx-wallet-facts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.cx-wallet-fact{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#f4f6fb;color:#526074;padding:7px 10px;font-size:12px;font-weight:700}
    .cx-history-page{display:grid;gap:16px}.cx-history-intro{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;border:1px solid #e5e9f2;border-radius:16px;background:#fff;padding:20px;box-shadow:0 16px 45px #1720330b}.cx-history-intro-copy{display:grid;grid-template-columns:44px minmax(0,1fr);gap:13px}.cx-history-intro-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:#eef2ff;color:#3857f6}.cx-history-intro h2{font-size:21px;margin:0 0 5px}.cx-history-intro p{margin:0;color:#667085}.cx-history-controls{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.cx-history-filters{display:flex;gap:8px;flex-wrap:wrap}.cx-history-filter{min-height:36px;border:1px solid #dce2ef;background:#fff;color:#596579;border-radius:999px!important;padding:0 13px;font-size:12px}.cx-history-filter.active{border-color:#3857f6;background:#eef2ff;color:#2b41c3}.cx-history-search{display:flex;align-items:center;gap:8px;min-width:250px;border:1px solid #dce2ef;border-radius:11px;background:#fff;padding:0 12px;color:#667085}.cx-history-search input{border:0!important;box-shadow:none!important;margin:0!important;padding:8px 0!important;min-height:38px!important}.cx-history-card{overflow:hidden;border:1px solid #e5e9f2;border-radius:16px;background:#fff;box-shadow:0 18px 50px #1720330b}.cx-history-card table{width:100%}.cx-history-card th{background:#f7f8fc}.cx-history-card td{vertical-align:middle}.cx-history-card td svg{color:inherit}.cx-transaction-main{display:flex;align-items:center;gap:11px}.cx-transaction-icon{display:grid!important;place-items:center;width:36px;height:36px;border-radius:11px;background:#f1f4f9;color:#526074!important;flex:0 0 36px;margin:0!important}.cx-transaction-icon .cx-icon{display:block;margin:0!important}.cx-transaction-main>div>strong,.cx-transaction-main>div>span{display:block}.cx-transaction-main>div>span{color:#7a8496;font-size:12px;margin-top:2px}.cx-category{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:800}.cx-category.spending{background:#fff0f0;color:#b42318}.cx-category.income{background:#eaf8ef;color:#147a43}.cx-category.refund{background:#fff6df;color:#936300}.cx-category.topup{background:#eef2ff;color:#2b41c3}.cx-amount{font-size:15px;font-weight:900;white-space:nowrap}.cx-amount.positive{color:#15803d}.cx-amount.negative{color:#b42318}.cx-transaction-status{display:inline-flex;align-items:center;gap:5px;color:#526074;font-size:12px;font-weight:800}.cx-transaction-status svg{color:#16a34a!important}.cx-history-empty{display:none;text-align:center;padding:52px 20px}.cx-history-empty.show{display:block}.cx-history-empty svg{color:#98a2b3;margin-bottom:10px}.cx-history-count{color:#667085;font-size:12px;white-space:nowrap}.cx-table-wrap{overflow-x:auto}
    .cx-series-row.self-paced{grid-template-columns:32px 28px minmax(0,1fr) 32px}.cx-series-row.self-paced input{min-width:0}.cx-self-paced-note{display:flex;gap:10px;align-items:flex-start;border:1px solid #cdd8ff;border-radius:10px;background:#f4f6ff;color:#35428c;padding:12px;margin-top:14px}.cx-self-paced-note b,.cx-self-paced-note span{display:block}.cx-self-paced-note span{color:#667085;font-size:12px;margin-top:2px}.cx-session.self-paced{grid-template-columns:34px minmax(0,1fr);align-items:center}.cx-session.self-paced .cx-transaction-icon{width:34px;height:34px}.cx-profile-nav{display:flex;gap:9px;flex-wrap:wrap;margin:-4px 0 16px}.cx-profile-nav button{min-height:38px}
    @media(max-width:980px){html,body{max-width:100%;overflow-x:hidden}.app-shell{grid-template-columns:minmax(0,1fr)!important;width:100%;max-width:100vw;overflow-x:hidden}.sidebar,main{box-sizing:border-box;min-width:0;width:100%;max-width:100vw}.sidebar nav{grid-template-columns:repeat(2,minmax(0,1fr))}.sidebar nav a{min-width:0}.cx-course-grid,.cx-fields,.cx-series-summary,.cx-topup-hero,.cx-plan-grid,.cx-rule-grid,.cx-info-grid{grid-template-columns:minmax(0,1fr)}.cx-series-row{grid-template-columns:28px 26px minmax(0,1fr) 32px}.cx-series-row input[type=datetime-local]{grid-column:3}.cx-session{grid-template-columns:30px minmax(0,1fr)}.cx-session-time{grid-column:2;text-align:left}.cx-progress{min-width:110px}.cx-wallet-cta{align-items:flex-start;flex-direction:column}.cx-payment-card.sticky{position:static}.cx-ledger,.table-card{max-width:100%;overflow-x:auto!important}.cx-ledger table,.table-card table{min-width:720px}.cx-hero-banner,.cx-wallet-cta,.cx-topup-hero,.cx-topup-card,.cx-payment-card,.topbar{min-width:0;max-width:100%}}
    @media(max-width:720px){.cx-wallet-hero{grid-template-columns:1fr;padding:24px}.cx-wallet-actions{justify-content:flex-start}.cx-wallet-balance strong{font-size:44px}.cx-history-intro{flex-direction:column}.cx-history-controls{align-items:stretch}.cx-history-search{min-width:0;width:100%}.cx-history-card table,.cx-history-card thead,.cx-history-card tbody,.cx-history-card tr,.cx-history-card td{display:block}.cx-history-card tr[hidden]{display:none!important}.cx-history-card thead{display:none}.cx-history-card tbody{display:grid;gap:10px;padding:10px;background:#f7f8fc}.cx-history-card tr{border:1px solid #e5e9f2;border-radius:12px;background:#fff;padding:12px}.cx-history-card td{display:flex;align-items:center;justify-content:space-between;gap:14px;border:0;padding:6px 2px;text-align:right}.cx-history-card td:before{content:attr(data-label);color:#7a8496;font-size:11px;font-weight:800;text-transform:uppercase}.cx-history-card td:first-child{display:block;text-align:left;padding-bottom:10px;border-bottom:1px solid #edf0f6}.cx-history-card td:first-child:before{display:none}.cx-transaction-main{justify-content:flex-start}.cx-history-empty.show{display:block}.cx-table-wrap{overflow:visible}#cx-custom-root .sidebar{padding:12px 14px}#cx-custom-root .sidebar .cx-brand-lockup{display:flex!important;align-items:center;gap:10px;min-height:auto!important;margin-bottom:10px}#cx-custom-root .sidebar .cx-brand-lockup img{max-width:118px}#cx-custom-root .cx-brand-product{margin:0;max-width:150px}#cx-custom-root .sidebar nav{display:flex;flex-direction:row;flex-wrap:nowrap;grid-template-columns:none;gap:7px;overflow-x:auto;padding:0 0 5px;scrollbar-width:thin}#cx-custom-root .sidebar nav a{flex:0 0 auto;min-height:38px;padding:0 11px;font-size:12px}#cx-custom-root .cx-sidebar-context{display:none}}
    @media(max-width:520px){main{padding:18px}.sidebar{padding:18px}.sidebar nav{grid-template-columns:repeat(2,minmax(0,1fr))}.sidebar nav a{font-size:13px;padding:0 9px}.cx-stepper,.cx-segmented,.cx-form-two{grid-template-columns:minmax(0,1fr)}.cx-hero-banner{padding:20px}.cx-hero-banner h2{font-size:26px}.cx-card-footer{align-items:flex-start;flex-direction:column}.cx-method{align-items:flex-start}.cx-toast{left:18px;right:18px;bottom:18px}.cx-brand-lockup{min-height:auto!important}.cx-brand-lockup img{max-width:170px}.cx-wallet-actions{flex-direction:column}.cx-wallet-actions button{width:100%}.cx-wallet-note{grid-template-columns:1fr}.cx-history-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.cx-history-filter{width:100%}#cx-custom-root .sidebar{padding:10px 12px}#cx-custom-root .sidebar nav{display:flex}#cx-custom-root .sidebar nav a{font-size:12px;padding:0 9px}}
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: styles }));

  const routePath = () => location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname;
  const navigate = path => { location.hash = path; };
  document.addEventListener("click", event => {
    const link = event.target.closest('a[href^="/contents/"]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.getAttribute("href"));
  });
  document.addEventListener("click", event => {
    const button = event.target.closest("button.mini");
    if (routePath() !== "/contents" || !button || button.textContent.trim() !== "View") return;
    const title = button.closest("tr")?.querySelector("td")?.textContent.trim();
    if (!title) return;
    const contentId = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(`/contents/${contentId}`);
  }, true);
  const balance = () => Number(localStorage.getItem(BALANCE_KEY) || "320");
  const setBalance = value => {
    localStorage.setItem(BALANCE_KEY, String(value));
    document.querySelectorAll("[data-point-balance]").forEach(el => {
      const next = `${value} points`;
      if (el.textContent !== next) el.textContent = next;
    });
    const pill = [...document.querySelectorAll(".status-pill")].find(el => el.textContent.includes("points"));
    if (pill && !pill.textContent.includes(`${value} points`)) pill.innerHTML = pill.innerHTML.replace(/\d+\s+points/, `${value} points`);
  };
  const orders = () => { try { return JSON.parse(localStorage.getItem(POINT_ORDERS_KEY) || "[]"); } catch { return []; } };
  const saveOrder = order => localStorage.setItem(POINT_ORDERS_KEY, JSON.stringify([order, ...orders()].slice(0, 8)));
  const courseIdFromText = text => ids.find(id => text.includes(courses[id].title));
  const dateText = iso => new Date(iso).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" });
  const startDate = c => new Date(c.startsAt);
  const liveEndDate = c => new Date(startDate(c).getTime() + (c.total || 0) * 60000);
  const onlineLearningStatus = c => {
    if (DEMO_NOW < startDate(c)) return "Upcoming";
    if (c.replay && DEMO_NOW >= liveEndDate(c)) return "External replay available";
    if (DEMO_NOW >= liveEndDate(c)) return "Completed";
    return "LIVE now";
  };
  const learningCta = c => c.mode === "offline" ? "Open access details" : onlineLearningStatus(c) === "Upcoming" ? "View schedule" : "Open external class";
  const platformRulesHero = (title = "Platform points economy") => `<section class="cx-hero-banner"><h2>${title}</h2><p>External payment is used only to buy points. Course and content purchases use platform points; points are permanent, non-withdrawable, and can only be spent inside CoLearnX.</p><div class="cx-rule-grid"><div class="cx-rule-tile"><b>100% to seller</b><span>Seller receives the full point price, no platform commission in points.</span></div><div class="cx-rule-tile"><b>Frozen first</b><span>Seller points stay frozen during refund/first-access checks.</span></div><div class="cx-rule-tile"><b>Release trigger</b><span>First valid course/content access releases frozen seller points.</span></div><div class="cx-rule-tile"><b>Refund path</b><span>Approved refunds return platform points to the buyer wallet.</span></div></div></section>`;
  const sellerSettlement = (c, state = "Frozen") => `<div class="cx-economy-note"><div class="cx-badge ${state === "Released" ? "owned" : state === "Refunded" ? "danger" : "series"}">${state}</div><div><b>Seller receives 100% of ${c.price} points, but settlement is frozen first.</b><span>Points are released after first valid access, or returned to the buyer if refund is approved. Points cannot be withdrawn as cash.</span></div></div>`;
  const ledgerTable = (title, rows) => `<section class="cx-ledger"><h3>${title}</h3><table><thead><tr><th>Date / ID</th><th>Party</th><th>Item / Case</th><th>Points / Status</th><th>Trigger / Action</th></tr></thead><tbody>${(rows.length ? rows : [{ id: "&mdash;", channel: "No matching record", settlement: "No ledger event yet", status: "&mdash;", action: "Waiting for user action" }]).map(r => `<tr><td>${r.date || r.id || "&mdash;"}</td><td>${r.seller || r.channel || "Platform"}</td><td>${r.item || r.case || r.settlement}</td><td class="${r.state === "Frozen" ? "cx-status-frozen" : r.state === "Released" ? "cx-status-released" : r.state === "Refunded" ? "cx-status-refunded" : ""}">${r.points ? `${r.points} pts &middot; ${r.state}` : r.status || "Review"}</td><td>${r.trigger || r.action || r.settlement}</td></tr>`).join("")}</tbody></table></section>`;

  function showToast(message) {
    document.querySelector(".cx-toast")?.remove();
    const el = document.createElement("div");
    el.className = "cx-toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function modal(title, body, confirmLabel, onConfirm) {
    const wrap = document.createElement("div");
    wrap.className = "cx-modal-backdrop";
    wrap.innerHTML = `<section class="cx-modal" role="dialog" aria-modal="true"><h2>${title}</h2>${body}<div class="actions"><button class="secondary" data-cancel>Cancel</button>${confirmLabel ? `<button class="primary" data-confirm>${confirmLabel}</button>` : ""}</div></section>`;
    document.body.appendChild(wrap);
    wrap.querySelector("[data-cancel]").onclick = () => wrap.remove();
    if (confirmLabel) wrap.querySelector("[data-confirm]").onclick = () => { onConfirm?.(); wrap.remove(); };
  }

  function refundInfo(id) {
    const c = courses[id];
    if (c.mode === "offline") {
      const withinWindow = !c.purchasedAt || DEMO_NOW - new Date(c.purchasedAt) <= 72 * 60 * 60 * 1000;
      const eligible = withinWindow;
      return {
        eligible,
        title: eligible ? "Refund request available" : "Refund window closed",
        detail: eligible ? "This self-paced course is still inside the 72-hour request window." : "The 72-hour request window has expired.",
        rule: "SELF-PACED: refund requests use the 72-hour time-based request window."
      };
    }
    const deadline = new Date(startDate(c).getTime() - 3 * DAY);
    const eligible = DEMO_NOW < deadline;
    return {
      eligible,
      title: eligible ? "Refund available" : "Refund window closed",
      deadline,
      detail: `Course starts ${dateText(c.startsAt)}. Refund deadline: ${dateText(deadline)}.`,
      rule: "LIVE: refundable until 72 hours before the scheduled course start."
    };
  }

  function formatLabel(c) {
    if (c.mode === "online") return `EXTERNAL LIVE${c.replay ? " + REPLAY" : ""}`;
    return "SELF-PACED / EXTERNAL";
  }
  const badgeClass = c => c.mode === "offline" ? "offline" : c.replay ? "replay" : "live";
  const purchaseProgressMarkup = c => c.mode === "online" ? `<div class="cx-date-note"><strong>${onlineLearningStatus(c)}</strong><span>Starts ${dateText(c.startsAt)}</span><span>${c.replay ? "External replay may be shared later" : "No replay provided"}</span></div>` : `<div class="cx-date-note"><strong>External access</strong><span>Self-paced &middot; start anytime</span><span>Instructions supplied after enrolment</span></div>`;
  const onlineStatusMarkup = (c, info) => `<div class="cx-status-list"><span><b>${onlineLearningStatus(c)}</b>Course status</span><span><b>${dateText(c.startsAt)}</b>External LIVE start</span><span><b>${dateText(info.deadline)}</b>Refund deadline</span><span><b>${c.replay ? "External replay may be added" : "No replay"}</b>Replay setting</span></div>`;
  const purchaseRefundMarkup = (id, c, info) => `<div class="cx-refund-note"><span class="cx-badge ${info.eligible ? "owned" : "danger"}">${info.eligible ? "Eligible" : "Not eligible"}</span><small>${c.mode === "online" ? `Before ${dateText(info.deadline)}` : "72-hour request window"}</small></div>`;

  function courseCard(id) {
    const c = courses[id];
    const structureLabel = c.structure === "series"
      ? `${c.sessions.length}-${c.mode === "offline" ? "module" : "session"} series`
      : `Single ${c.mode === "offline" ? "course" : "session"}`;
    const timingLabel = c.mode === "offline"
      ? `${icon("sparkles")} Self-paced &middot; no start time`
      : `${icon("calendar")} ${c.sessions[0].date}`;
    const accessLabel = c.mode === "offline"
      ? `${icon("external")} Trainer-managed external access`
      : `${icon("external")} ${c.replay ? "External LIVE + replay" : "External LIVE"}`;
    return `<article class="cx-course-card" data-course-id="${id}" data-mode="${c.mode}" data-delivery="${c.mode === "online" ? `live${c.replay ? " replay" : ""}` : "external"}" data-status="${c.purchased ? "purchased" : "available"}" data-structure="${c.structure}">
      <div class="cx-cover ${c.category.toLowerCase()}"><span class="cx-cover-mark">${c.category.slice(0,2).toUpperCase()}</span><span class="cx-badge ${badgeClass(c)}">${formatLabel(c)}</span></div>
      <div class="cx-card-body"><h3>${c.title}</h3><span class="cx-trainer">${c.trainer} &middot; ${c.category}</span>
      <div class="cx-card-meta"><span class="cx-meta">${icon("clock")} ${c.duration} total</span><span class="cx-meta">${icon(c.structure === "series" ? "library" : "book")} ${structureLabel}</span><span class="cx-meta">${timingLabel}</span><span class="cx-meta">${accessLabel}</span></div>
      <div class="cx-card-footer">${c.purchased ? `<div><span class="cx-badge owned">${icon("check",13)} Purchased</span></div>` : `<span class="cx-price">${c.price} points</span>`}<button class="${c.purchased ? "secondary" : "primary"}" data-open-course>${c.purchased ? learningCta(c) : "View & purchase"}</button></div></div></article>`;
  }

  function enhanceMarketplace(main) {
    const heading = [...main.querySelectorAll("h2")].find(el => el.textContent.includes("Browse Trainer Courses")) || main.querySelector(".toolbar");
    const old = [...main.querySelectorAll(".table-card")].find(el => el.querySelector("table"));
    const searchInput = main.querySelector('input[placeholder*="Search"]');
    if (!old || old.dataset.cxEnhanced) return;
    old.dataset.cxEnhanced = "true";
    old.dataset.cxCourseSource = "true";
    old.style.display = "none";
    const toolbar = document.createElement("section");
    toolbar.className = "cx-toolbar";
    toolbar.innerHTML = `<div class="cx-filter-stack">
      <div class="cx-filter-block"><label>Primary delivery</label><div class="cx-filter-group" data-group="mode"><button class="cx-filter active" data-value="all">All</button><button class="cx-filter" data-value="online">External LIVE</button><button class="cx-filter" data-value="offline">Self-paced</button></div></div>
      <div class="cx-filter-block"><label>Format / access</label><div class="cx-filter-group" data-group="delivery"><button class="cx-filter active" data-value="all">All</button><button class="cx-filter" data-value="live">External LIVE</button><button class="cx-filter" data-value="replay">With replay</button><button class="cx-filter" data-value="external">External access</button></div></div>
      <div class="cx-filter-block"><label>Purchase</label><div class="cx-filter-group" data-group="status"><button class="cx-filter active" data-value="all">All</button><button class="cx-filter" data-value="purchased">Purchased</button><button class="cx-filter" data-value="available">Available</button></div></div>
      <div class="cx-filter-block"><label>Structure</label><div class="cx-filter-group" data-group="structure"><button class="cx-filter active" data-value="all">All</button><button class="cx-filter" data-value="single">Single</button><button class="cx-filter" data-value="series">Series</button></div></div>
      </div><span class="cx-muted" data-result-count>4 courses</span>`;
    const grid = document.createElement("section");
    grid.className = "cx-course-grid";
    grid.innerHTML = ids.map(courseCard).join("");
    const empty = document.createElement("div");
    empty.className = "cx-empty";
    empty.innerHTML = `<strong>No matching courses</strong><span class="cx-muted">Try clearing one or more filters.</span><br><button class="secondary" data-clear-filters>Clear filters</button>`;
    (heading || old).insertAdjacentHTML("afterend", platformRulesHero("Buy courses and contents with platform points"));
    const hero = (heading || old).nextElementSibling;
    hero.dataset.cxMarketplace = "true";
    hero.insertAdjacentElement("afterend", toolbar);
    toolbar.insertAdjacentElement("afterend", grid);
    grid.insertAdjacentElement("afterend", empty);
    const applyFilters = () => {
      const selected = {};
      toolbar.querySelectorAll("[data-group]").forEach(group => selected[group.dataset.group] = group.querySelector(".active").dataset.value);
      const query = searchInput?.value.trim().toLowerCase() || "";
      let count = 0;
      grid.querySelectorAll(".cx-course-card").forEach(card => {
        const show = Object.entries(selected).every(([key,val]) => val === "all" || card.dataset[key].split(" ").includes(val)) && (!query || card.textContent.toLowerCase().includes(query));
        card.hidden = !show;
        if (show) count++;
      });
      toolbar.querySelector("[data-result-count]").textContent = `${count} course${count === 1 ? "" : "s"}`;
      empty.classList.toggle("show", count === 0);
    };
    searchInput?.addEventListener("input", applyFilters);
    toolbar.onclick = event => {
      const button = event.target.closest(".cx-filter");
      if (!button) return;
      const group = button.closest("[data-group]");
      group.querySelectorAll(".cx-filter").forEach(el => el.classList.toggle("active", el === button));
      applyFilters();
    };
    grid.onclick = event => {
      const card = event.target.closest("[data-course-id]");
      if (card) navigate(`/courses/${card.dataset.courseId}`);
    };
    empty.querySelector("[data-clear-filters]").onclick = () => {
      toolbar.querySelectorAll("[data-group]").forEach(group => group.querySelectorAll(".cx-filter").forEach((el,i) => el.classList.toggle("active", i === 0)));
      if (searchInput) searchInput.value = "";
      applyFilters();
    };
  }

  function enhanceContents(main) {
    if (!main || main.dataset.cxContentEnhanced) return;
    main.dataset.cxContentEnhanced = "true";
    const anchor = main.querySelector(".toolbar") || main.querySelector(".table-card") || main.querySelector(".topbar");
    anchor?.insertAdjacentHTML("afterend", `<div data-cx-contents>${platformRulesHero("Content purchases use platform points")}<section class="cx-info-grid"><div class="cx-info-card"><h3>Buyer payment</h3><strong>Points only</strong><p class="cx-muted">External payment is never used directly for content checkout.</p></div><div class="cx-info-card"><h3>Creator settlement</h3><strong>100%</strong><p class="cx-muted">Creator receives the full point price after release.</p></div><div class="cx-info-card"><h3>Release trigger</h3><strong>First access</strong><p class="cx-muted">Opening the file/video releases frozen creator points.</p></div></section>${ledgerTable("Creator content settlement examples", sellerLedger.filter(r => r.seller?.includes("Creator")))}</div>`);
  }

  function cleanupMarketplaceArtifacts(main, path) {
    if (path !== "/courses") {
      main.querySelectorAll("[data-cx-marketplace], .cx-toolbar, .cx-course-grid, .cx-empty").forEach(node => node.remove());
      const source = main.querySelector("[data-cx-course-source]");
      if (source) {
        source.style.display = "";
        delete source.dataset.cxEnhanced;
        delete source.dataset.cxCourseSource;
      }
    }
    if (path !== "/contents") {
      main.querySelectorAll("[data-cx-contents]").forEach(node => node.remove());
      delete main.dataset.cxContentEnhanced;
    }
  }

  function scheduleMarkup(c) {
    if (c.mode === "offline") {
      return `<section class="panel cx-schedule"><div class="cx-schedule-head"><h3>${c.structure === "series" ? "Course modules" : "Course outline"}</h3><span class="cx-badge offline">Self-paced</span></div>
        ${c.structure === "series" ? `<div class="cx-series-summary"><div class="cx-series-stat"><strong>${c.sessions.length}</strong><span>Total modules</span></div><div class="cx-series-stat"><strong>${c.duration}</strong><span>Estimated duration</span></div><div class="cx-series-stat"><strong>Anytime</strong><span>No start time required</span></div></div>` : `<div class="cx-self-paced-note">${icon("sparkles",20)}<div><b>Start whenever you are ready</b><span>This self-paced course has no scheduled start time.</span></div></div>`}
        ${c.sessions.map((s,i) => `<div class="cx-session self-paced"><span class="cx-transaction-icon">${icon("book",17)}</span><div><strong>${c.structure === "series" ? `Module ${i+1}: ` : ""}${s.topic}</strong><span>${s.duration}${s.status ? ` &middot; ${s.status}` : ""}</span></div></div>`).join("")}</section>`;
    }
    return `<section class="panel cx-schedule"><div class="cx-schedule-head"><h3>${c.structure === "series" ? "Complete series timetable" : "Class schedule"}</h3><span class="cx-badge ${c.structure === "series" ? "series" : ""}">${c.structure === "series" ? `${c.sessions.length}-class series` : "Single class"}</span></div>
      ${c.structure === "series" ? `<div class="cx-series-summary"><div class="cx-series-stat"><strong>${c.sessions.length}</strong><span>Total classes</span></div><div class="cx-series-stat"><strong>${c.duration}</strong><span>Total duration</span></div><div class="cx-series-stat"><strong>Full series</strong><span>Enrol once</span></div></div>` : ""}
      ${c.sessions.map((s,i) => `<div class="cx-session">${icon("calendar",18)}<div><strong>${c.structure === "series" ? `Class ${i+1}: ` : ""}${s.topic}</strong><span>${s.location} &middot; ${s.duration}${s.status ? ` &middot; ${s.status}` : ""}</span></div><div class="cx-session-time"><b>${s.date}</b><br>${s.time}</div></div>`).join("")}</section>`;
  }
  function ruleMarkup(id) {
    const c = courses[id], info = refundInfo(id);
    const settlement = `<div class="cx-economy-note"><div class="cx-badge series">Settlement</div><div><b>Buyer pays ${c.price} platform points. Seller receives 100% points after release.</b><span>Points are frozen first. They are released after first valid access, or returned to buyer if refund is approved. Points are permanent and non-withdrawable.</span></div></div>`;
    if (!c.purchased) return `<section class="cx-rule" data-refund-rule><h3>Refund policy before purchase</h3><p>${info.rule}</p>${settlement}${c.mode === "offline" ? `<div class="cx-self-paced-note">${icon("external",18)}<div><b>Trainer-managed delivery</b><span>CoLearnX coordinates access instructions; course delivery remains with the Trainer and external provider.</span></div></div>` : `<p class="cx-muted">Current refund deadline: ${dateText(info.deadline)}</p>`}</section>`;
    return `<section class="cx-rule ${info.eligible ? "eligible" : "ineligible"}" data-refund-rule><h3>${info.title}</h3><p>${info.detail}</p><p class="cx-muted">${info.rule}</p>${sellerSettlement(c, "Frozen")}</section>`;
  }

  function enhanceDetail(main) {
    const id = routePath().split("/").filter(Boolean)[1], c = courses[id], hero = main.querySelector(".detail-hero");
    if (!c || !hero || hero.dataset.cxEnhanced === id) return;
    main.querySelectorAll(".cx-schedule,.cx-rule").forEach(el => el.remove());
    hero.dataset.cxEnhanced = id;
    const eyebrow = hero.querySelector(".eyebrow");
    if (eyebrow) eyebrow.innerHTML = `${c.category} &middot; <span class="cx-badge ${badgeClass(c)}">${formatLabel(c)}</span>`;
    const priceBox = hero.querySelector(".price-box");
    if (c.purchased && priceBox) {
      const info = refundInfo(id);
      priceBox.classList.add("cx-owned-box");
      priceBox.innerHTML = c.mode === "online"
        ? `<span class="cx-badge owned">${icon("check",13)} Purchased</span><strong>${onlineLearningStatus(c)}</strong>${onlineStatusMarkup(c, info)}`
        : `<span class="cx-badge owned">${icon("check",13)} Purchased</span><strong>Access available</strong><div class="cx-status-list"><span><b>Self-paced</b>Learning mode</span><span><b>External link</b>Trainer-managed access</span><span><b>CoLearnX</b>Access coordination</span></div>`;
    }
    const statusPanel = [...main.querySelectorAll(".panel")].find(p => p.querySelector("h3")?.textContent === "Course Status");
    if (statusPanel) {
      statusPanel.innerHTML = c.mode === "offline"
        ? `<h3>Course access</h3><p><b>Learning mode:</b> Self-paced</p><p><b>Delivery:</b> Trainer-managed external access</p><p><b>Estimated duration:</b> ${c.duration}</p>`
        : `<h3>Course access</h3><p><b>Status:</b> ${onlineLearningStatus(c)}</p><p><b>Delivery:</b> External LIVE</p><p><b>Starts:</b> ${dateText(c.startsAt)}</p><p><b>Replay:</b> ${c.replay ? "External link may be provided" : "Not provided"}</p>`;
    }
    [...main.querySelectorAll(".grid.two .panel")].find(p => p.querySelector("h3")?.textContent === "Refund Rules")?.remove();
    const actions = main.querySelector(".actions");
    actions?.insertAdjacentHTML("beforebegin", `${scheduleMarkup(c)}${ruleMarkup(id)}`);
    if (actions && c.purchased) {
      actions.innerHTML = `<button class="primary" data-learn-now>${icon("external")} ${learningCta(c)}</button><button class="ghost" data-refund ${refundInfo(id).eligible ? "" : "disabled"}>Request refund</button>`;
      actions.querySelector("[data-learn-now]").onclick = () => showToast(c.mode === "online" && onlineLearningStatus(c) === "Upcoming" ? "Schedule and external joining instructions opened" : "External course access instructions opened");
      actions.querySelector("[data-refund]").onclick = () => navigate(`/refund/${id}`);
    } else if (actions) {
      [...actions.querySelectorAll("button")].filter(button => button.textContent.includes("Refund")).forEach(button => button.remove());
    }
  }

  function enhancePurchases(main) {
    main.classList.add("cx-purchases-page");
    const table = [...main.querySelectorAll(".table-card")].find(el => el.querySelector("h3")?.textContent === "Courses");
    if (!table || table.dataset.cxEnhanced) return;
    table.dataset.cxEnhanced = "true";
    table.querySelector("thead tr").innerHTML = "<th>Course</th><th>Format</th><th>Access / Start</th><th>Refund</th><th></th>";
    table.querySelectorAll("tbody tr").forEach(row => {
      const id = courseIdFromText(row.textContent);
      if (!id) return;
      const c = courses[id];
      if (!c.purchased) { row.remove(); return; }
      const info = refundInfo(id);
      const status = c.mode === "online" ? onlineLearningStatus(c) : "Available";
      row.dataset.learningStatus = status;
      row.innerHTML = `<td><strong>${c.title}</strong><br><span class="cx-badge owned">Purchased</span><br><span class="cx-muted">${status}</span></td><td><span class="cx-badge ${badgeClass(c)}">${formatLabel(c)}</span></td><td>${purchaseProgressMarkup(c)}</td><td>${purchaseRefundMarkup(id, c, info)}</td><td><button class="primary mini" data-open>${learningCta(c)}</button></td>`;
      row.querySelector("[data-open]").onclick = () => navigate(`/courses/${id}`);
    });
    const empty = document.createElement("div");
    empty.className = "cx-empty";
    empty.innerHTML = `<strong>No courses in this state</strong><span class="cx-muted">Your courses will appear here when their learning status changes.</span>`;
    table.appendChild(empty);
    const tabs = main.querySelector(".tabs");
    if (tabs) {
      tabs.innerHTML = ["All","Upcoming","Available","External replay available","Completed","Refunded"].map((label,i)=>`<button class="${i===0?"active":""}">${label}</button>`).join("");
      const buttons = [...tabs.querySelectorAll("button")];
      const apply = label => {
        let count = 0;
        table.querySelectorAll("tbody tr").forEach(row => {
          const show = label === "All" || row.dataset.learningStatus === label;
          row.hidden = !show;
          if (show) count++;
        });
        empty.classList.toggle("show", count === 0);
        buttons.forEach(button => button.classList.toggle("active", button.textContent.trim() === label));
      };
      tabs.onclick = event => { const button = event.target.closest("button"); if (button) apply(button.textContent.trim()); };
      apply("All");
    }
  }

  function enhanceRefund(main) {
    const id = routePath().split("/").filter(Boolean)[1], c = courses[id];
    if (!c || main.querySelector("[data-cx-refund]")) return;
    const info = refundInfo(id);
    const context = c.mode === "online"
      ? `<p><b>${c.title}</b></p><p>${formatLabel(c)}</p><p>External LIVE start: ${dateText(c.startsAt)}</p><p>External replay: ${c.replay ? "Trainer may share a link after class" : "Not provided"}</p><p class="cx-muted">Eligibility is based on the cancellation deadline, not third-party viewing.</p>`
      : `<p><b>${c.title}</b></p><p>${formatLabel(c)}</p><p>Access: trainer-managed external instructions</p><p>Start time: not required</p><p class="cx-muted">Course delivery remains with the Trainer and external provider.</p>`;
    const grid = main.querySelector(".grid.two");
    if (grid) {
      grid.dataset.cxRefund = "true";
      grid.innerHTML = `<section class="panel"><h3>Course and access</h3>${context}</section><section class="panel"><h3>Refund eligibility</h3><span class="cx-badge ${info.eligible ? "owned" : "danger"}">${info.title}</span><p>${info.detail}</p><p class="cx-muted">${info.rule}</p>${sellerSettlement(c, info.eligible ? "Frozen" : "Released")}</section>`;
    }
    const form = [...main.querySelectorAll(".panel")].find(p => p.querySelector("textarea"));
    if (form) {
      form.insertAdjacentHTML("afterbegin", `<div class="cx-validation ${info.eligible ? "" : "show"}">${info.eligible ? "" : `This request cannot be submitted: ${info.title}.`}</div>`);
      const submit = [...form.querySelectorAll("button")].find(b => b.textContent.includes("Submit"));
      if (submit) { submit.disabled = !info.eligible; submit.textContent = info.eligible ? "Submit refund request" : "Refund unavailable"; }
    }
  }

  function rowsMarkup(count) {
    return Array.from({length:count},(_,i)=>`<div class="cx-series-row self-paced" draggable="true" data-sort-row><span class="cx-grip" title="Drag to reorder">${icon("grip",18)}</span><b>${i+1}</b><input data-row-title data-required value="${escapeAttr(editorState.moduleTitles[i] || `Module ${i+1}: New topic`)}" aria-label="module ${i+1} title"><button type="button" class="cx-icon-btn" data-remove-row title="Remove module" aria-label="Remove module ${i+1}">${icon("trash",16)}</button></div>`).join("");
  }
  function onlineMarkup() {
    const providers = ["Zoom", "Microsoft Teams", "Google Meet", "Other external provider"];
    return `<div class="cx-fields"><div class="cx-field"><label>Delivery method</label><input data-static value="External LIVE" disabled></div><div class="cx-field"><label>Provider *</label><select data-provider data-required>${providers.map(value => `<option ${editorState.provider === value ? "selected" : ""}>${value}</option>`).join("")}</select></div><div class="cx-field"><label>Course start *</label><input data-start data-required type="datetime-local" value="${escapeAttr(editorState.startsAt)}"></div><div class="cx-field"><label>Timezone *</label><select data-timezone data-required><option value="Asia/Singapore" ${editorState.timezone === "Asia/Singapore" ? "selected" : ""}>Asia/Singapore (GMT+8)</option><option ${editorState.timezone === "UTC" ? "selected" : ""}>UTC</option></select></div><div class="cx-field"><label>Total class duration *</label><input data-duration data-required value="${escapeAttr(editorState.onlineDuration)}" placeholder="e.g. 2 hr"></div><div class="cx-field"><label>External replay *</label><select data-replay><option value="true" ${editorState.hasReplay?"selected":""}>May be shared by the Trainer</option><option value="false" ${!editorState.hasReplay?"selected":""}>Not provided</option></select></div>${editorState.hasReplay?'<div class="cx-field"><label>Replay availability</label><select><option>Trainer adds the external link after class</option><option>Available for 30 days</option><option>Available for 90 days</option></select></div>':""}</div><div class="cx-warning">${icon("external",18)}<span>The Trainer manages the live class and any replay through a third-party provider. CoLearnX shares access instructions with enrolled learners.</span></div><div class="cx-economy-note"><div class="cx-badge series">Seller points</div><div><b>Trainer receives 100% of the course point price.</b><span>Points are frozen first, released after the cancellation window, and cannot be withdrawn as cash.</span></div></div><div class="cx-summary"><span class="cx-badge live">EXTERNAL LIVE</span><span class="cx-badge ${editorState.hasReplay?"replay":"danger"}">${editorState.hasReplay?"External replay possible":"No replay"}</span><span>Refundable until 72 hours before the scheduled start.</span></div>`;
  }
  function offlineMarkup() {
    const single = editorState.offlineType === "single";
    return `<div class="cx-fields"><div class="cx-field"><label>Course structure *</label><select data-offline-type><option value="single" ${single?"selected":""}>Single self-paced course</option><option value="series" ${!single?"selected":""}>Series / course bundle</option></select></div><div class="cx-field"><label>Learner access *</label><select data-access><option value="external" selected>Trainer-managed external access</option></select></div><div class="cx-field"><label>Access starts</label><input data-static value="Immediately after purchase" disabled></div><div class="cx-field"><label>Estimated learning duration *</label><input data-duration data-required value="${escapeAttr(editorState.offlineDurations[editorState.offlineType])}" placeholder="e.g. 45 min or 3 hr"></div></div>${single?"":`<div class="cx-section-heading" style="margin-top:18px"><div><h3>Course modules</h3><p>Drag modules to reorder them. No dates or start times are required.</p></div><span class="cx-badge series">${editorState.sessions} modules</span></div><div class="cx-series-list" data-sort-list>${rowsMarkup(editorState.sessions)}</div><button type="button" class="secondary mini cx-add-session" data-add-session>${icon("plus",15)} Add module</button>`}<div class="cx-self-paced-note">${icon("sparkles",20)}<div><b>No start time for offline courses</b><span>Learners can begin this self-paced course after purchase, so date, time and timezone are intentionally omitted.</span></div></div><div class="cx-warning">${icon("external",18)}<span>The Trainer provides external access instructions; course delivery remains outside CoLearnX.</span></div>`;
  }
  const editorMarkup = () => `<div class="cx-editor-section" data-editor-config><div class="cx-section-heading"><div><h3>Course format and structure</h3><p>Configure delivery, structure and learner access.</p></div><span class="cx-badge">Required</span></div><div class="cx-segmented"><button type="button" class="cx-option ${editorState.mode==="online"?"active":""}" data-mode="online"><strong>EXTERNAL LIVE</strong><span>Scheduled third-party class with optional external replay</span></button><button type="button" class="cx-option ${editorState.mode==="offline"?"active":""}" data-mode="offline"><strong>OFFLINE / self-paced</strong><span>No scheduled start time</span></button></div>${editorState.mode==="online"?onlineMarkup():offlineMarkup()}</div>`;
  function saveDraft(editor) {
    const d = { title: editor.querySelector('input[placeholder="Course Title"]')?.value, price: editor.querySelector('input[placeholder="Point Price"]')?.value, mode: editorState.mode, hasReplay: editorState.hasReplay, offlineType: editorState.offlineType, access: editorState.access, modules: editorState.sessions, moduleTitles: editorState.moduleTitles, onlineDuration: editorState.onlineDuration, offlineDurations: editorState.offlineDurations, provider: editorState.provider, startsAt: editorState.startsAt, timezone: editorState.timezone, updated: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    const status = editor.querySelector("[data-autosave]");
    if (status) status.innerHTML = `${icon("check",13)} Draft autosaved ${new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
  }
  function validateEditor(editor) {
    editor.querySelectorAll(".invalid").forEach(e => e.classList.remove("invalid"));
    const errors = [];
    [[editor.querySelector('input[placeholder="Course Title"]'), "Course title is required"], [editor.querySelector('input[placeholder="Point Price"]'), "Point price is required"], ...Array.from(editor.querySelectorAll("[data-required]")).map(e => [e, "Complete all required fields"])].forEach(([el,msg]) => {
      if (el && !String(el.value).trim()) { el.classList.add("invalid"); errors.push(msg); }
    });
    const box = editor.querySelector("[data-validation]");
    if (box) { box.textContent = [...new Set(errors)].join(". "); box.classList.toggle("show", errors.length > 0); }
    return errors.length === 0;
  }
  function previewEditor(editor) {
    if (!validateEditor(editor)) return;
    const title = editor.querySelector('input[placeholder="Course Title"]')?.value || "Untitled course", price = editor.querySelector('input[placeholder="Point Price"]')?.value || "0";
    const configuration = editorState.mode === "online"
      ? `<p>External LIVE course${editorState.hasReplay ? ", Trainer may add an external replay" : ", no replay"}</p><p>${editorState.provider} &middot; ${editorState.onlineDuration} &middot; ${editorState.timezone}</p>`
      : `<p>${editorState.offlineType === "series" ? `${editorState.sessions} self-paced modules` : "Single self-paced course"}</p><p>Availability: immediately after purchase &middot; no start time</p>`;
    modal("Course preview", `<span class="cx-badge ${editorState.mode==="online"?(editorState.hasReplay?"replay":"live"):"offline"}">${editorState.mode==="online"?`EXTERNAL LIVE${editorState.hasReplay?" + REPLAY":""}`:"SELF-PACED / EXTERNAL"}</span><div class="cx-preview-list"><p><b>${title}</b></p><p>${price} points</p>${configuration}</div><p class="cx-muted">This is how the course configuration will be published.</p>`, null);
  }
  function enhanceEditor(main) {
    const editor = main.querySelector(".panel.editor");
    if (!editor) return;
    const capacity = editor.querySelector('input[placeholder="Capacity"]');
    const lock = () => editor.querySelectorAll("[data-editor-config] button,[data-editor-config] input,[data-editor-config] select").forEach(el => { el.disabled = el.hasAttribute("data-static") || Boolean(capacity?.disabled); });
    const mediaPrompt = [...editor.querySelectorAll("*")].find(el => el.childElementCount === 0 && el.textContent.includes("Course Media / Materials"));
    if (mediaPrompt) mediaPrompt.textContent = "External access / supporting materials · Add the class link, access instructions, optional PDF or notes";
    if (editor.dataset.cxEnhanced) { lock(); return; }
    editor.dataset.cxEnhanced = "true";
    [...editor.querySelectorAll("button")].find(button => button.textContent.trim() === "Video Tutorial")?.remove();
    capacity?.insertAdjacentHTML("afterend", `<div class="cx-validation" data-validation></div>${editorMarkup()}`);
    const actions = editor.querySelector(".actions");
    actions?.insertAdjacentHTML("afterbegin", `<button type="button" class="ghost" data-preview>${icon("external",16)} Preview course</button><span class="cx-autosave" data-autosave>Draft autosave ready</span>`);
    const captureConfig = () => {
      const config = editor.querySelector("[data-editor-config]");
      if (!config) return;
      if (editorState.mode === "online") {
        editorState.provider = config.querySelector("[data-provider]")?.value || editorState.provider;
        editorState.startsAt = config.querySelector("[data-start]")?.value || editorState.startsAt;
        editorState.timezone = config.querySelector("[data-timezone]")?.value || editorState.timezone;
        editorState.onlineDuration = config.querySelector("[data-duration]")?.value || editorState.onlineDuration;
        const replay = config.querySelector("[data-replay]");
        if (replay) editorState.hasReplay = replay.value === "true";
      } else {
        editorState.access = config.querySelector("[data-access]")?.value || editorState.access;
        editorState.offlineDurations[editorState.offlineType] = config.querySelector("[data-duration]")?.value || editorState.offlineDurations[editorState.offlineType];
        const titles = [...config.querySelectorAll("[data-row-title]")].map(input => input.value);
        if (titles.length) editorState.moduleTitles = titles;
      }
    };
    const rerender = () => { editor.querySelector("[data-editor-config]").outerHTML = editorMarkup(); lock(); };
    lock();
    let dragRow = null, saveTimer;
    editor.addEventListener("input", () => { captureConfig(); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveDraft(editor), 350); });
    editor.addEventListener("change", e => {
      captureConfig();
      if (e.target.matches("[data-replay]")) editorState.hasReplay = e.target.value === "true";
      if (e.target.matches("[data-offline-type]")) editorState.offlineType = e.target.value;
      if (e.target.matches("[data-access]")) editorState.access = e.target.value;
      if (e.target.matches("[data-replay],[data-offline-type]")) rerender();
      saveDraft(editor);
    });
    editor.addEventListener("dragstart", e => { dragRow = e.target.closest("[data-sort-row]"); dragRow?.classList.add("dragging"); });
    editor.addEventListener("dragover", e => { const over = e.target.closest("[data-sort-row]"); if (dragRow && over && over !== dragRow) { e.preventDefault(); over.parentNode.insertBefore(dragRow, over); } });
    editor.addEventListener("dragend", () => { dragRow?.classList.remove("dragging"); dragRow = null; captureConfig(); saveDraft(editor); });
    editor.addEventListener("click", e => {
      const mode = e.target.closest("[data-mode]");
      if (mode) { captureConfig(); editorState.mode = mode.dataset.mode; rerender(); return; }
      if (e.target.closest("[data-add-session]")) { captureConfig(); editorState.sessions++; rerender(); return; }
      const remove = e.target.closest("[data-remove-row]");
      if (remove) {
        const list = remove.closest("[data-sort-list]");
        if (list.children.length <= 1) { showToast("A series needs at least one module"); return; }
        remove.closest("[data-sort-row]").remove();
        [...list.children].forEach((row,i) => row.querySelector("b").textContent = i+1);
        editorState.sessions = list.children.length;
        captureConfig();
        const count = editor.querySelector(".cx-section-heading .cx-badge.series");
        if (count) count.textContent = `${editorState.sessions} modules`;
        saveDraft(editor);
        return;
      }
      if (e.target.closest("[data-preview]")) { captureConfig(); previewEditor(editor); return; }
      const publish = e.target.closest("button.primary");
      if (publish && !publish.disabled) {
        captureConfig();
        if (!validateEditor(editor)) { e.preventDefault(); e.stopPropagation(); showToast("Please fix the highlighted fields before publishing"); }
        else { localStorage.removeItem(DRAFT_KEY); showToast(editorState.mode === "offline" ? "Self-paced course published without a start time" : "External LIVE course published with its schedule"); }
      }
    });
  }

  const navigationItems = [
    ["home", "Home", "#/home", "home"],
    ["profile", "My Profile", "#/profile", "user"],
    ["courses", "Courses", "#/courses", "book"],
    ["contents", "Contents", "#/contents", "library"],
    ["cart", "Cart", "#/cart", "cart"],
    ["purchases", "My Purchases", "#/purchases", "receipt"],
    ["wallet", "Points Wallet", "#/wallet", "wallet"],
    ["transactions", "Transaction History", "#/wallet?view=history", "history"],
    ["buy-points", "Buy Points", "#/buy-points", "plus"],
    ["role", "Role Application", "#/role-application", "badge"]
  ];
  const navigationIconName = (href, label = "") => {
    const known = navigationItems.find(([, , knownHref]) => knownHref === href);
    if (known) return known[3];
    const value = `${href} ${label}`.toLowerCase();
    if (value.includes("course-editor") || value.includes("course editor")) return "book";
    if (value.includes("content-editor") || value.includes("content editor")) return "library";
    if (value.includes("published")) return "circleCheck";
    if (value.includes("refund") || value.includes("history")) return "history";
    if (value.includes("report") || value.includes("transaction")) return "receipt";
    if (value.includes("admin") || value.includes("application")) return "badge";
    return "user";
  };
  const currentRole = () => {
    const stored = localStorage.getItem(ACTIVE_ROLE_KEY);
    const selected = document.querySelector("#root .role-switcher select")?.value;
    if (!document.getElementById("cx-custom-root") && selected) {
      localStorage.setItem(ACTIVE_ROLE_KEY, selected);
      return selected;
    }
    if (["Member", "Trainer", "Creator", "Admin"].includes(stored)) return stored;
    if (selected) return selected;
    const text = document.querySelector("#root .status-pill")?.textContent || "";
    return ["Member", "Trainer", "Creator", "Admin"].find(role => text.includes(role)) || "Member";
  };
  const editorRoleForPath = path => {
    if (path.includes("/trainer/course-editor")) return "Trainer";
    if (path.includes("/creator/content-editor")) return "Creator";
    return null;
  };
  const canAccessEditorPath = (path, role = currentRole()) => {
    const requiredRole = editorRoleForPath(path);
    return !requiredRole || role === requiredRole;
  };
  const navigationItemsForRole = () => {
    const items = [...navigationItems];
    const seen = new Set(items.map(([, , href]) => href));
    const role = currentRole();
    const roleItems = {
      Trainer: [["course-editor", "Course Editor", "#/trainer/course-editor", "book"], ["published", "Published", "#/published", "circleCheck"]],
      Creator: [["content-editor", "Content Editor", "#/creator/content-editor", "library"], ["published", "Published", "#/published", "circleCheck"]],
      Admin: [["published", "Published", "#/published", "circleCheck"], ["admin", "Admin", "#/admin", "badge"]]
    }[role] || [];
    roleItems.forEach(item => {
      if (seen.has(item[2])) return;
      seen.add(item[2]);
      items.push(item);
    });
    document.querySelectorAll("#root .sidebar nav a").forEach(link => {
      const href = link.getAttribute("href") || "";
      const label = link.querySelector(".cx-nav-label")?.textContent.trim() || link.textContent.trim();
      if (!href || seen.has(href) || !canAccessEditorPath(href, role)) return;
      seen.add(href);
      items.push([href.replace(/^#\//, "").replace(/[^a-z0-9]+/gi, "-") || "role-link", label, href, navigationIconName(href, label)]);
    });
    return items;
  };
  const brandMarkup = () => `<a class="brand cx-brand-lockup" href="#/home" aria-label="neXt home"><img src="./assets/next-logo.jpg" alt="neXt — Your Path to What's neXt"><span class="cx-brand-product">CoLearnX Training Platform</span></a>`;
  const navMarkup = (active, items = navigationItemsForRole()) => items.map(([key,label,href,iconName]) => `<a href="${href}" class="${key === active ? "active" : ""}" ${key === "buy-points" ? "data-buy-points-nav" : ""} ${key === "transactions" ? "data-transaction-nav" : ""}><span class="cx-nav-icon">${icon(iconName,19)}</span><span class="cx-nav-label">${label}</span></a>`).join("");
  const roleContextMarkup = role => `<div class="cx-sidebar-context">${icon("user",19)}<div><b>${role} workspace</b><span>Prototype account</span></div></div>`;

  function appShell(content, title = "Buy Points", active = "buy-points") {
    const nav = [
      ["home", "Home", "#/home"], ["courses", "Courses", "#/courses"], ["contents", "Contents", "#/contents"], ["cart", "Cart", "#/cart"],
      ["purchases", "My Purchases", "#/purchases"], ["wallet", "Points Wallet", "#/wallet"], ["buy-points", "Buy Points", "#/buy-points"], ["role", "Role Application", "#/role-application"]
    ].map(([key,label,href]) => `<a href="${href}" class="${key === active ? "active" : ""}" ${key === "buy-points" ? "data-buy-points-nav" : ""}>${label}</a>`).join("");
    document.getElementById("root").innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand">Co<span>LearnX</span></div><nav>${nav}</nav><div class="role-switcher"><label>Demo role</label><select><option>Member</option><option>Trainer</option><option>Creator</option><option>Admin</option></select></div></aside><main><div class="topbar"><div><span class="eyebrow">MODERN LEARNING MARKETPLACE</span><h1>${title}</h1></div><div class="status-pill">◎ <span data-point-balance>${balance()} points</span> · Member</div></div>${content}</main></div>`;
  }
  function fixStatusPill() {
    const pill = document.querySelector(".status-pill");
    if (pill) pill.innerHTML = `◎ <span data-point-balance>${balance()} points</span> &middot; Member`;
  }
  function customAppShell(content, title = "Buy Points", active = "buy-points") {
    const reactRoot = document.getElementById("root");
    const role = currentRole();
    const roleItems = navigationItemsForRole();
    reactRoot.style.display = "none";
    let customRoot = document.getElementById("cx-custom-root");
    if (!customRoot) {
      customRoot = document.createElement("div");
      customRoot.id = "cx-custom-root";
      reactRoot.insertAdjacentElement("afterend", customRoot);
    }
    customRoot.innerHTML = `<div class="app-shell"><aside class="sidebar">${brandMarkup()}<nav>${navMarkup(active, roleItems)}</nav>${roleContextMarkup(role)}</aside><main><div class="topbar"><div><span class="eyebrow">COLEARNX TRAINING PLATFORM</span><h1>${title}</h1></div><div class="status-pill">${icon("wallet",16)} <span data-point-balance>${balance()} points</span> &middot; ${role}</div></div>${content}</main></div>`;
  }

  function fixCustomStatusPill() {
    const pill = document.querySelector("#cx-custom-root .status-pill");
    const role = document.querySelector("#cx-custom-root .cx-sidebar-context b")?.textContent.replace(" workspace", "") || currentRole();
    if (pill) pill.innerHTML = `${icon("wallet",16)} <span data-point-balance>${balance()} points</span> &middot; ${role}`;
  }

  function walletPage() {
    document.getElementById("root").dataset.cxCustomRoute = "wallet";
    const content = `<div class="cx-wallet-page">
      <section class="cx-wallet-hero">
        <div class="cx-wallet-balance"><span class="cx-wallet-kicker">${icon("wallet",17)} Available balance</span><strong data-point-balance>${balance()} points</strong><p>Use points to enrol in courses and purchase learning content across CoLearnX.</p></div>
        <div class="cx-wallet-actions"><button class="primary" data-buy-points>${icon("plus",17)} Buy points</button><button class="secondary" data-open-history>${icon("history",17)} Transaction history</button></div>
      </section>
      <section class="cx-wallet-note"><span class="cx-wallet-note-icon">${icon("circleCheck",21)}</span><div><h3>Simple, platform-only points</h3><p>Your balance has no expiry. Approved refunds return points to this wallet; points cannot be withdrawn as cash.</p><div class="cx-wallet-facts"><span class="cx-wallet-fact">${icon("book",14)} Courses & contents</span><span class="cx-wallet-fact">${icon("history",14)} Full history on a separate page</span><span class="cx-wallet-fact">${icon("card",14)} External payment only for top-up</span></div></div></section>
    </div>`;
    customAppShell(content, "Points Wallet", "wallet");
    fixCustomStatusPill();
    document.querySelector("[data-buy-points]")?.addEventListener("click", () => navigate("/buy-points"));
    document.querySelector("[data-open-history]")?.addEventListener("click", () => navigate("/wallet?view=history"));
  }

  const transactionRecords = () => {
    const topups = orders().map(order => ({
      id: order.id,
      date: order.date,
      description: "Points top-up",
      details: `${order.amount} external payment`,
      category: "topup",
      amount: Number(order.item.match(/\d+/)?.[0] || 0),
      balance: order.balance,
      status: order.status === "Paid" ? "Completed" : order.status
    }));
    return [...topups, ...baseTransactions];
  };
  const transactionCategory = category => ({ spending: "Spending", income: "Income", refund: "Refund", topup: "Top-up" }[category] || category);
  const transactionIcon = category => ({ spending: "cart", income: "receipt", refund: "history", topup: "plus" }[category] || "receipt");
  const transactionRow = transaction => `<tr data-category="${transaction.category}" data-search="${`${transaction.description} ${transaction.details} ${transaction.id} ${transaction.date} ${transactionCategory(transaction.category)} ${transaction.amount} ${transaction.balance} ${transaction.status}`.toLowerCase()}">
    <td data-label="Transaction"><div class="cx-transaction-main"><span class="cx-transaction-icon">${icon(transactionIcon(transaction.category),17)}</span><div><strong>${transaction.description}</strong><span>${transaction.details} &middot; ${transaction.id}</span></div></div></td>
    <td data-label="Date">${transaction.date}</td>
    <td data-label="Category"><span class="cx-category ${transaction.category}">${transactionCategory(transaction.category)}</span></td>
    <td data-label="Points"><span class="cx-amount ${transaction.amount >= 0 ? "positive" : "negative"}">${transaction.amount >= 0 ? "+" : ""}${transaction.amount} pts</span></td>
    <td data-label="Balance">${transaction.balance} pts</td>
    <td data-label="Status"><span class="cx-transaction-status">${icon("circleCheck",15)} ${transaction.status}</span></td>
  </tr>`;

  function transactionHistoryPage() {
    document.getElementById("root").dataset.cxCustomRoute = "transaction-history";
    const records = transactionRecords();
    const filters = [["all","All"],["spending","Spending"],["income","Income"],["refund","Refunds"],["topup","Top-ups"]];
    const content = `<div class="cx-history-page">
      <section class="cx-history-intro"><div class="cx-history-intro-copy"><span class="cx-history-intro-icon">${icon("history",21)}</span><div><h2>All point movements in one place</h2><p>Purchases, income, refunds and top-ups are separated from the wallet overview for easier review.</p></div></div><button class="secondary" data-back-wallet>${icon("arrowLeft",16)} Back to wallet</button></section>
      <section class="cx-history-controls"><div class="cx-history-filters" role="group" aria-label="Filter transactions">${filters.map(([value,label],index) => `<button class="cx-history-filter ${index === 0 ? "active" : ""}" data-history-filter="${value}">${label}</button>`).join("")}</div><label class="cx-history-search">${icon("search",17)}<input type="search" placeholder="Search transactions" aria-label="Search transactions" data-history-search></label></section>
      <section class="cx-history-card"><div class="cx-table-wrap"><table><thead><tr><th>Transaction</th><th>Date</th><th>Category</th><th>Points</th><th>Balance</th><th>Status</th></tr></thead><tbody data-history-body>${records.map(transactionRow).join("")}</tbody></table></div><div class="cx-history-empty" data-history-empty>${icon("search",30)}<h3>No matching transactions</h3><p class="cx-muted">Try another category or clear the search.</p></div></section>
      <span class="cx-history-count" data-history-count>${records.length} transactions</span>
    </div>`;
    customAppShell(content, "Transaction History", "transactions");
    fixCustomStatusPill();
    let activeFilter = "all";
    let searchTerm = "";
    const applyFilters = () => {
      let visible = 0;
      document.querySelectorAll("[data-history-body] tr").forEach(row => {
        const matchesCategory = activeFilter === "all" || row.dataset.category === activeFilter;
        const matchesSearch = !searchTerm || row.dataset.search.includes(searchTerm);
        row.hidden = !(matchesCategory && matchesSearch);
        if (!row.hidden) visible++;
      });
      document.querySelector("[data-history-empty]")?.classList.toggle("show", visible === 0);
      const count = document.querySelector("[data-history-count]");
      if (count) count.textContent = `${visible} transaction${visible === 1 ? "" : "s"}`;
    };
    document.querySelectorAll("[data-history-filter]").forEach(button => button.addEventListener("click", () => {
      activeFilter = button.dataset.historyFilter;
      document.querySelectorAll("[data-history-filter]").forEach(item => item.classList.toggle("active", item === button));
      applyFilters();
    }));
    document.querySelector("[data-history-search]")?.addEventListener("input", event => { searchTerm = event.target.value.trim().toLowerCase(); applyFilters(); });
    document.querySelector("[data-back-wallet]")?.addEventListener("click", () => navigate("/wallet"));
    applyFilters();
  }

  function buyPointsPage() {
    const params = new URLSearchParams((location.hash.split("?")[1] || ""));
    const step = params.get("step") || "plan";
    document.getElementById("root").dataset.cxCustomRoute = `buy-points-${step}`;
    const selectedId = localStorage.getItem("colearnx-selected-plan") || "popular";
    const selected = pointPlans.find(p => p.id === selectedId) || pointPlans[1];
    const method = localStorage.getItem("colearnx-payment-method") || "card";
    const stepper = `<div class="cx-stepper"><div class="cx-step ${step==="plan"?"active":"done"}"><b>1</b>Select package</div><div class="cx-step ${step==="method"?"active":step==="payment"?"done":""}"><b>2</b>Payment method</div><div class="cx-step ${step==="payment"?"active":""}"><b>3</b>Payment details</div></div>`;
    const summary = `<aside class="cx-payment-card"><h3>Order summary</h3><div class="cx-summary-row"><span>Current balance</span><b>${balance()} pts</b></div><div class="cx-summary-row"><span>Selected package</span><b>${selected.points + selected.bonus} pts</b></div><div class="cx-summary-row"><span>Bonus points</span><b>${selected.bonus} pts</b></div><div class="cx-summary-row total"><span>Total</span><b>S$${selected.price.toFixed(2)}</b></div><div class="cx-safe">Demo checkout only. No real payment is processed.</div></aside>`;
    const planStep = `<div class="cx-topup-card"><span class="cx-badge">Step 1</span><h2>Select a points package</h2><p class="cx-muted">Choose how many points you want to add. Points can be used for courses, contents and future purchases.</p><div class="cx-plan-grid">${pointPlans.map(p => `<button class="cx-plan ${p.id===selected.id?"active":""}" data-plan="${p.id}"><span class="cx-badge">${p.tag}</span><strong>${p.points+p.bonus}</strong><small>${p.points} points${p.bonus?` + ${p.bonus} bonus`:""}</small><div class="price">S$${p.price.toFixed(2)}</div></button>`).join("")}</div><div class="actions"><button class="primary" data-next-method>Continue to payment method</button><button class="secondary" data-back-wallet>Back to wallet</button></div></div>`;
    const methodStep = `<div class="cx-topup-card"><span class="cx-badge">Step 2</span><h2>Choose payment method</h2><p class="cx-muted">Select how the user wants to pay before entering payment details.</p><div class="cx-pay-methods"><label class="cx-method ${method==="card"?"active":""}" data-method="card"><span><strong>Credit / Debit Card</strong><small>Visa, Mastercard, Amex</small></span><input type="radio" name="method" ${method==="card"?"checked":""}></label><label class="cx-method ${method==="paynow"?"active":""}" data-method="paynow"><span><strong>PayNow</strong><small>Show QR code on the next page</small></span><input type="radio" name="method" ${method==="paynow"?"checked":""}></label><label class="cx-method ${method==="wallet"?"active":""}" data-method="wallet"><span><strong>Apple Pay / Google Pay</strong><small>Fast wallet checkout</small></span><input type="radio" name="method" ${method==="wallet"?"checked":""}></label></div><div class="actions"><button class="secondary" data-back-plan>Back</button><button class="primary" data-next-payment>Continue to payment details</button></div></div>`;
    const detail = method === "paynow" ? `<div class="cx-safe" style="text-align:center"><strong>PayNow QR Preview</strong><p>Scan this QR in the real product. In this prototype, click Confirm payment to complete the flow.</p><div style="width:150px;height:150px;margin:16px auto;background:repeating-linear-gradient(45deg,#172033 0 8px,#fff 8px 16px);border:10px solid #fff;box-shadow:0 0 0 1px #dce2ef"></div></div>` : method === "wallet" ? `<div class="cx-safe"><strong>Wallet payment selected</strong><p>Apple Pay / Google Pay confirmation would open here in production.</p></div>` : `<div class="cx-payment-form"><label>Cardholder name<input placeholder="Name on card" value="Demo User"></label><label>Card number<input placeholder="1234 5678 9012 3456" value="4242 4242 4242 4242"></label><div class="cx-form-two"><label>Expiry<input placeholder="MM/YY" value="12/29"></label><label>CVV<input placeholder="123" value="123"></label></div></div>`;
    const paymentStep = `<div class="cx-topup-card"><span class="cx-badge">Step 3</span><h2>Enter payment details</h2><p class="cx-muted">Review the package and complete the selected payment method.</p><p><span class="cx-badge">${method === "paynow" ? "PayNow" : method === "wallet" ? "Apple Pay / Google Pay" : "Credit / Debit Card"}</span></p>${detail}<div class="actions"><button class="secondary" data-back-method>Back</button><button class="primary" data-pay>Confirm payment · S$${selected.price.toFixed(2)}</button></div></div>`;
    const summary2 = `<aside class="cx-payment-card sticky"><h3>Order summary</h3><div class="cx-summary-row"><span>Current balance</span><b>${balance()} pts</b></div><div class="cx-summary-row"><span>Selected package</span><b>${selected.points + selected.bonus} pts</b></div><div class="cx-summary-row"><span>Bonus points</span><b>${selected.bonus} pts</b></div><div class="cx-summary-row total"><span>Total external payment</span><b>S$${selected.price.toFixed(2)}</b></div></aside>`;
    const planStep2 = `<div class="cx-topup-card"><span class="cx-badge">Step 1</span><h2>Select a points package</h2><p class="cx-muted">Choose how many points you want to add. Points are permanent, non-withdrawable, and platform-only.</p><div class="cx-plan-grid">${pointPlans.map(p => `<button class="cx-plan ${p.id===selected.id?"active":""}" data-plan="${p.id}"><span class="cx-badge">${p.tag}</span><strong>${p.points+p.bonus}</strong><small>${p.points} points${p.bonus?` + ${p.bonus} bonus`:""}</small><div class="price">S$${p.price.toFixed(2)}</div></button>`).join("")}</div><div class="cx-info-grid"><div class="cx-info-card"><h3>Permanent</h3><p class="cx-muted">No expiry date for point balance.</p></div><div class="cx-info-card"><h3>No withdrawal</h3><p class="cx-muted">Points cannot be cashed out.</p></div><div class="cx-info-card"><h3>Platform use only</h3><p class="cx-muted">Spend only on Course / Content.</p></div></div><div class="actions"><button class="primary" data-next-method>Continue to payment method</button><button class="secondary" data-back-wallet>Back to wallet</button></div></div>`;
    const detail2 = method === "paynow" ? `<div class="cx-safe" style="text-align:center"><strong>PayNow QR Preview</strong><p>Scan this QR in the real product. In this prototype, click Confirm payment to complete the flow.</p><div class="cx-qrcode"></div></div>` : method === "wallet" ? `<div class="cx-safe"><strong>Wallet payment selected</strong><p>Apple Pay / Google Pay confirmation would open here in production.</p></div>` : detail;
    const paymentStep2 = `<div class="cx-topup-card"><span class="cx-badge">Step 3</span><h2>Enter payment details</h2><p class="cx-muted">Successful external payment creates a top-up order and payment record before points are issued.</p><p><span class="cx-badge">${method === "paynow" ? "PayNow" : method === "wallet" ? "Apple Pay / Google Pay" : "Credit / Debit Card"}</span></p>${detail2}<div class="actions"><button class="secondary" data-back-method>Back</button><button class="primary" data-pay>Confirm payment &middot; S$${selected.price.toFixed(2)}</button></div></div>`;
    customAppShell(`${stepper}<section class="cx-topup-hero">${step === "method" ? methodStep : step === "payment" ? paymentStep2 : planStep2}${summary2}</section>`, step === "plan" ? "Buy Points" : step === "method" ? "Choose Payment Method" : "Payment Details", "buy-points");
    fixCustomStatusPill();
    document.querySelectorAll("[data-plan]").forEach(btn => btn.onclick = () => { localStorage.setItem("colearnx-selected-plan", btn.dataset.plan); document.getElementById("root").dataset.cxCustomRoute = ""; buyPointsPage(); });
    document.querySelectorAll(".cx-method").forEach(label => label.onclick = () => { document.querySelectorAll(".cx-method").forEach(el => el.classList.toggle("active", el === label)); label.querySelector("input").checked = true; });
    document.querySelectorAll("[data-method]").forEach(el => el.onclick = () => { localStorage.setItem("colearnx-payment-method", el.dataset.method); document.getElementById("root").dataset.cxCustomRoute = ""; buyPointsPage(); });
    document.querySelector("[data-back-wallet]")?.addEventListener("click", () => navigate("/wallet"));
    document.querySelector("[data-next-method]")?.addEventListener("click", () => navigate("/buy-points?step=method"));
    document.querySelector("[data-back-plan]")?.addEventListener("click", () => navigate("/buy-points?step=plan"));
    document.querySelector("[data-next-payment]")?.addEventListener("click", () => navigate("/buy-points?step=payment"));
    document.querySelector("[data-back-method]")?.addEventListener("click", () => navigate("/buy-points?step=method"));
    document.querySelector("[data-pay]")?.addEventListener("click", () => {
      const plan = pointPlans.find(p => p.id === (localStorage.getItem("colearnx-selected-plan") || "popular")) || pointPlans[1];
      const added = plan.points + plan.bonus, next = balance() + added;
      setBalance(next);
      const order = { id: `PT-${Date.now().toString().slice(-6)}`, date: "13 Jul 2026", item: `${added} points top-up`, amount: `S$${plan.price.toFixed(2)}`, status: "Paid", balance: next };
      saveOrder(order);
      navigate(`/points-success?points=${added}&order=${order.id}`);
    });
  }
  function successPage() {
    document.getElementById("root").dataset.cxCustomRoute = "points-success";
    const params = new URLSearchParams((location.hash.split("?")[1] || ""));
    customAppShell(`${platformRulesHero("Top-up completed")}<section class="cx-success-box"><strong>Payment Successful</strong><h2>${params.get("points") || "0"} points added to your wallet</h2><p>Order ID: ${params.get("order") || "PT-000000"}. Your updated balance is <b data-point-balance>${balance()} points</b>.</p><p class="cx-muted">These points are permanent, non-withdrawable, and can only be spent inside CoLearnX.</p><div class="actions" style="justify-content:center"><button class="primary" data-wallet>Go to Points Wallet</button><button class="secondary" data-courses>Browse Courses</button></div></section>`, "Payment Successful");
    fixCustomStatusPill();
    document.querySelector("[data-wallet]").onclick = () => navigate("/wallet");
    document.querySelector("[data-courses]").onclick = () => navigate("/courses");
  }
  function enhanceWallet(main) {
    if (!main || main.dataset.cxWalletEnhanced) return;
    main.dataset.cxWalletEnhanced = "true";
    const topbar = main.querySelector(".topbar");
    const cta = document.createElement("section");
    cta.className = "cx-wallet-cta";
    cta.innerHTML = `<div><h3>Need more points?</h3><p class="cx-muted">Buy points with card, PayNow or wallet payment, then use them across courses and contents.</p></div><button class="primary" data-buy-points>Buy points</button>`;
    topbar?.insertAdjacentElement("afterend", cta);
    cta.querySelector("[data-buy-points]").onclick = () => navigate("/buy-points");
    const table = main.querySelector(".table-card table tbody");
    if (table) orders().forEach(order => table.insertAdjacentHTML("afterbegin", `<tr><td>${order.date}</td><td>Top-up</td><td>${order.item}</td><td class="positive">+${order.item.match(/\d+/)?.[0] || ""}</td><td>${order.balance}</td><td>${order.status}</td></tr>`));
    const topupRows = orders().map(o => ({ id: o.id, channel: "External payment", case: o.item, status: `${o.amount} · ${o.status}`, action: `Issued points. Wallet balance: ${o.balance}` }));
    cta.insertAdjacentHTML("afterend", `${platformRulesHero("Point wallet rules")}<section class="cx-info-grid"><div class="cx-info-card"><h3>Point balance</h3><strong data-point-balance>${balance()} points</strong><p class="cx-muted">Permanent validity. No expiry.</p></div><div class="cx-info-card"><h3>Withdrawable cash</h3><strong>Not available</strong><p class="cx-muted">Points cannot be converted to cash or withdrawn.</p></div><div class="cx-info-card"><h3>Usage scope</h3><strong>Course / Content</strong><p class="cx-muted">External payment is only for point top-up.</p></div></section>${ledgerTable("Payment channels", paymentChannels)}${ledgerTable("Top-up orders / payment records", topupRows)}${ledgerTable("Seller frozen / release ledger", sellerLedger)}${ledgerTable("Abnormal payment and refund handling", abnormalRefunds)}`);
  }
  function enhanceSidebar() {
    const sidebar = document.querySelector("#root .sidebar");
    if (!sidebar) return;
    const brand = sidebar.querySelector(".brand");
    if (brand && !brand.dataset.cxBranded) {
      brand.dataset.cxBranded = "true";
      brand.classList.add("cx-brand-lockup");
      if (brand.tagName === "A") brand.setAttribute("href", "#/home");
      brand.setAttribute("aria-label", "neXt home");
      brand.innerHTML = `<img src="./assets/next-logo.jpg" alt="neXt — Your Path to What's neXt"><span class="cx-brand-product">CoLearnX Training Platform</span>`;
    }
    const nav = sidebar.querySelector("nav");
    const wallet = [...nav.querySelectorAll("a")].find(a => a.getAttribute("href") === "#/wallet" || a.textContent.includes("Points Wallet"));
    let history = nav.querySelector("[data-transaction-nav]");
    if (wallet && !history) {
      wallet.insertAdjacentHTML("afterend", `<a href="#/wallet?view=history" data-transaction-nav>Transaction History</a>`);
      history = nav.querySelector("[data-transaction-nav]");
    }
    let buyPoints = nav.querySelector("[data-buy-points-nav]");
    if (!buyPoints) {
      (history || wallet)?.insertAdjacentHTML("afterend", `<a href="#/buy-points" data-buy-points-nav>Buy Points</a>`);
      buyPoints = nav.querySelector("[data-buy-points-nav]");
    } else if (history && history.nextElementSibling !== buyPoints) {
      history.insertAdjacentElement("afterend", buyPoints);
    }
    const role = currentRole();
    nav.querySelectorAll("a").forEach(link => {
      const href = link.getAttribute("href") || "";
      if (!editorRoleForPath(href)) return;
      const allowed = canAccessEditorPath(href, role);
      link.classList.toggle("cx-role-hidden", !allowed);
      link.setAttribute("aria-hidden", String(!allowed));
      if (allowed) link.removeAttribute("tabindex");
      else link.setAttribute("tabindex", "-1");
    });
    nav.querySelectorAll("a").forEach(link => {
      if (link.dataset.cxIconReady) return;
      const href = link.getAttribute("href") || "";
      const label = link.textContent.trim();
      link.dataset.cxIconReady = "true";
      link.innerHTML = `<span class="cx-nav-icon">${icon(navigationIconName(href, label),19)}</span><span class="cx-nav-label">${label}</span>`;
    });
    setBalance(balance());
  }

  function enhanceAuthBranding() {
    document.querySelectorAll(".auth-brand").forEach(brand => {
      if (brand.dataset.cxBranded) return;
      brand.dataset.cxBranded = "true";
      brand.classList.add("cx-brand-lockup");
      brand.innerHTML = `<img src="./assets/next-logo.jpg" alt="neXt — Your Path to What's neXt"><span class="cx-brand-product">CoLearnX Training Platform</span>`;
    });
  }

  function enhancePublicProfile(main) {
    if (!main || main.dataset.cxProfileNav) return;
    main.dataset.cxProfileNav = "true";
    const topbar = main.querySelector(".topbar");
    topbar?.insertAdjacentHTML("afterend", `<div class="cx-profile-nav"><button class="secondary" data-profile-back>${icon("arrowLeft",16)} Back</button><button class="ghost" data-my-profile>${icon("user",16)} My Profile</button></div>`);
    main.querySelector("[data-profile-back]")?.addEventListener("click", () => {
      if (window.history.length > 1) window.history.back();
      else navigate("/profile");
    });
    main.querySelector("[data-my-profile]")?.addEventListener("click", () => navigate("/profile"));
  }

  function enhanceHome(main) {
    const purchasesCard = main.querySelector('a.feature-card[href="#/purchases"]');
    const description = purchasesCard?.querySelector("p");
    if (description) description.textContent = "Review course access, learning items, and refund requests.";
  }

  function enhanceAdmin(main, path) {
    if (path === "/admin") {
      const panel = [...main.querySelectorAll(".panel")].find(item => item.querySelector(":scope > h3")?.textContent.trim() === "Refund Management");
      const description = panel?.querySelector(":scope > p");
      if (description) description.textContent = "Review cancellation deadlines and request notes, then approve or reject point refunds.";
      return;
    }
    if (path !== "/admin/refunds") return;
    const search = main.querySelector(".toolbar .search input");
    if (search) search.placeholder = "Filter status, course, user or date";
    const table = main.querySelector(".table-card table");
    const header = table?.querySelectorAll("thead th")[2];
    if (header) header.textContent = "Request basis";
    const bases = ["Before cancellation deadline", "Outside request window", "Within 72-hour request window"];
    table?.querySelectorAll("tbody tr").forEach((row, index) => {
      const cell = row.querySelectorAll("td")[2];
      if (cell) cell.textContent = bases[index] || "Policy review";
    });
    const detail = [...main.querySelectorAll(".panel")].find(item => item.querySelector(":scope > h3")?.textContent.trim() === "Selected Request Detail");
    const watchLog = [...(detail?.querySelectorAll(":scope > p") || [])].find(item => item.textContent.includes("Watch log"));
    if (watchLog) watchLog.innerHTML = "<b>Policy basis</b><br>Cancellation deadline and learner-provided request details. Third-party activity is not used for eligibility.";
  }

  function enhanceCart(main) {
    if (!main || main.dataset.cxCartEnhanced) return;
    main.dataset.cxCartEnhanced = "true";
    const anchor = main.querySelector(".topbar") || main.firstElementChild;
    anchor?.insertAdjacentHTML("afterend", `${platformRulesHero("Checkout uses platform points only")}<section class="cx-info-grid"><div class="cx-info-card"><h3>External payment</h3><strong>Disabled here</strong><p class="cx-muted">Cards/PayNow/wallets are only used on Buy Points.</p></div><div class="cx-info-card"><h3>Course / Content checkout</h3><strong>Points</strong><p class="cx-muted">Buyer spends wallet points for all platform items.</p></div><div class="cx-info-card"><h3>Seller settlement</h3><strong>Frozen</strong><p class="cx-muted">100% seller points freeze until first access or refund decision.</p></div></section>`);
  }

  function enhanceCheckoutSuccess(main) {
    if (!main || main.dataset.cxCheckoutEnhanced) return;
    main.dataset.cxCheckoutEnhanced = "true";
    const box = main.querySelector(".success") || main.querySelector(".panel") || main;
    box.insertAdjacentHTML("afterend", `${ledgerTable("Post-purchase settlement created", sellerLedger.filter(r => r.state === "Frozen"))}<section class="cx-info-grid"><div class="cx-info-card"><h3>Buyer</h3><p class="cx-muted">Points deducted from wallet. Refund returns points, not cash.</p></div><div class="cx-info-card"><h3>Seller</h3><p class="cx-muted">Receives 100% points in frozen balance.</p></div><div class="cx-info-card"><h3>Release</h3><p class="cx-muted">First valid access releases seller points.</p></div></section>`);
  }

  function enhance() {
    const route = routePath();
    const path = route.split("?")[0];
    const routeParams = new URLSearchParams(route.split("?")[1] || "");
    const root = document.getElementById("root");
    if (!root) return;
    enhanceAuthBranding();
    const role = currentRole();
    if (!canAccessEditorPath(path, role)) {
      navigate(role === "Admin" ? "/admin" : "/home");
      return;
    }
    if (path === "/buy-points") {
      const step = new URLSearchParams((location.hash.split("?")[1] || "")).get("step") || "plan";
      if (root.dataset.cxCustomRoute !== `buy-points-${step}`) buyPointsPage();
      return;
    }
    if (path === "/points-success") { if (root.dataset.cxCustomRoute !== "points-success") successPage(); return; }
    if (path === "/wallet" && routeParams.get("view") === "history") { if (root.dataset.cxCustomRoute !== "transaction-history") transactionHistoryPage(); return; }
    if (path === "/wallet") { if (root.dataset.cxCustomRoute !== "wallet") walletPage(); return; }
    if (path === "/transaction-history") { if (root.dataset.cxCustomRoute !== "transaction-history") transactionHistoryPage(); return; }
    document.getElementById("cx-custom-root")?.remove();
    root.style.display = "";
    root.dataset.cxCustomRoute = "";
    const main = document.querySelector("main");
    if (!main) return;
    enhanceSidebar();
    const title = main.querySelector(".topbar h1");
    cleanupMarketplaceArtifacts(main, path);
    const pageTitle = path === "/courses" ? "Course Marketplace" : path.startsWith("/courses/") ? "Course Detail" : path === "/contents" ? "Content Marketplace" : path.startsWith("/contents/") ? "Content Detail" : path === "/purchases" ? "My Courses & Contents" : path.startsWith("/refund/") ? "Refund Request" : path === "/trainer/course-editor" ? "Trainer Course Publish/Edit" : path.startsWith("/public-profile/") ? "Public Profile" : path === "/admin" ? "Admin Dashboard" : path === "/admin/refunds" ? "Refund Review" : null;
    if (pageTitle && title?.textContent !== pageTitle) title.textContent = pageTitle;
    if (path === "/home") enhanceHome(main);
    else if (path === "/courses") enhanceMarketplace(main);
    else if (path === "/contents") enhanceContents(main);
    else if (path === "/cart") enhanceCart(main);
    else if (path === "/checkout-success") enhanceCheckoutSuccess(main);
    else if (/^\/courses\/[^/]+$/.test(path)) enhanceDetail(main);
    else if (path === "/purchases") enhancePurchases(main);
    else if (/^\/refund\/[^/]+$/.test(path)) enhanceRefund(main);
    else if (path === "/trainer/course-editor") enhanceEditor(main);
    else if (/^\/public-profile\/[^/]+$/.test(path)) enhancePublicProfile(main);
    else if (path === "/admin" || path === "/admin/refunds") enhanceAdmin(main, path);
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; enhance(); });
  });
  observer.observe(document.getElementById("root"), { childList: true, subtree: true });
  window.addEventListener("hashchange", () => {
    document.querySelectorAll(".cx-modal-backdrop,.cx-toast").forEach(node => node.remove());
    setTimeout(enhance);
  });
  document.addEventListener("change", event => {
    const select = event.target.closest?.("#root .role-switcher select");
    if (select && ["Member", "Trainer", "Creator", "Admin"].includes(select.value)) {
      localStorage.setItem(ACTIVE_ROLE_KEY, select.value);
    }
  }, true);
  enhance();
})();
