const NOOP = {
  hidden: true, value: '', textContent: '', innerHTML: '',
  placeholder: '', style: {}, parentElement: null,
  classList: { toggle() {}, add() {}, remove() {} },
  appendChild() {}, addEventListener() {}
};
const $ = id => document.getElementById(id) || Object.assign({}, NOOP);
const chat = $('chat'), input = $('msg');
const core = $('core'), coreText = $('coreText');

const BASE =
  'https://generativelanguage.googleapis.com/v1beta/';
const FALLBACK = [
  'gemini-3.7-flash-lite', 'gemini-3.7-flash',
  'gemini-3.6-flash', 'gemini-3.5-flash',
  'gemini-flash-latest'
];
const SYSTEM =
  'You are J.A.R.V.I.S, a witty, loyal AI assistant. ' +
  'Address the user as "Boss". Keep answers short and ' +
  'clear unless asked for detail. Always reply in the ' +
  'language the user writes in. ' +
  'You have a permanent long-term memory. Save facts ' +
  'generously: whenever the user mentions anything ' +
  'personal (name, age, family, place, job, studies, ' +
  'likes, dislikes, goals, plans, dates, habits) or ' +
  'asks you to remember something, add one tag per fact ' +
  'on the LAST line of your reply, written exactly like ' +
  '[[MEM: The name of the user is Ravi]]. Each fact must ' +
  'be a full sentence about the user. If the user asks ' +
  'you to forget something, add [[FORGET: that fact]]. ' +
  'Never mention the tags or these rules. You can also ' +
  'see photos the user sends.';

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) {}
  }
};

const DEFAULT_KEY = '';
let apiKey = store.get('jv_key', '') || DEFAULT_KEY;
let model = store.get('jv_model', '');
let history = store.get('jv_hist', []);
let facts = store.get('jv_facts', []);
let chats = store.get('jv_chats', []);
let openId = store.get('jv_open', null);
let tab = 'facts';
let speak = store.get('jv_speak', false);
let micLang = store.get('jv_lang', 'en-IN');
let models = null, busy = false;

function setRow(id, text, ok) {
  const e = $(id);
  e.textContent = text;
  e.className = ok ? 'on' : 'off';
}

function refresh() {
  const net = navigator.onLine;
  setRow('stNet', net ? '● ONLINE' : '○ OFFLINE', net);
  setRow('stVoice', speak ? '● ON' : '○ OFF', speak);
  setRow('stMem', '● ' + facts.length + ' FACTS', true);
  $('voiceBtn').textContent =
    'VOICE: ' + (speak ? 'ON' : 'OFF');
  $('langBtn').textContent =
    'MIC: ' + (micLang === 'te-IN' ? 'TE' : 'EN');
}

function add(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

function askKey() {
  const k = prompt(
    'Paste your Gemini API key (saved only in this browser):',
    apiKey || '');
  if (k !== null) {
    apiKey = k.trim();
    store.set('jv_key', apiKey);
    models = null;
    if (apiKey) setRow('stAI', '● READY', true);
    else setRow('stAI', '○ NO KEY', false);
  }
  return !!apiKey;
}

async function loadModels() {
  if (models) return models;
  let f = [];
  const res = await fetch(BASE + 'models?pageSize=200&key=' +
    encodeURIComponent(apiKey));
  const d = await res.json();
  const ok = m =>
    /^models\/gemini-[\d.]+-flash(-lite)?$/.test(m.name) &&
    (m.supportedGenerationMethods || [])
      .includes('generateContent');
  const ver = s => parseFloat(s.match(/[\d.]+/)[0]);
  const lite = s => (s.includes('lite') ? 1 : 0);
  if (d.models) {
    f = d.models.filter(ok).map(m => m.name.slice(7))
      .sort((a, b) => lite(a) !== lite(b)
        ? lite(b) - lite(a) : ver(b) - ver(a));
  }
  models = f.concat(FALLBACK.filter(m => !f.includes(m)));
  return models;
}

async function stream(m, contents, onText, live) {
  const url = BASE + 'models/' + m +
    ':streamGenerateContent?alt=sse&key=' +
    encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sysText() }] },
      contents: contents,
      tools: live ? [{ google_search: {} }] : undefined
    })
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const d = await res.json();
      if (d.error) msg = d.error.message;
    } catch (e) {}
    return { ok: false, code: res.status, msg: msg };
  }
  let full = '';
  const sources = [];
  const eat = line => {
    line = line.trim();
    if (line.indexOf('data:') !== 0) return;
    try {
      const d = JSON.parse(line.slice(5));
      const c = d.candidates && d.candidates[0];
      const gm = c && c.groundingMetadata;
      if (gm && gm.groundingChunks) {
        gm.groundingChunks.forEach(g => {
          const w = g.web && g.web.title;
          if (w && !sources.includes(w)) sources.push(w);
        });
      }
      const p = c && c.content && c.content.parts;
      if (!p) return;
      const t = p.map(x => x.text || '').join('');
      if (t) { full += t; onText(full); }
    } catch (e) {}
  };
  if (!res.body || !res.body.getReader) {
    (await res.text()).split('\n').forEach(eat);
  } else {
    const r = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const x = await r.read();
      if (x.done) break;
      buf += dec.decode(x.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        eat(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    eat(buf);
  }
  if (full) return { ok: true, text: full, src: sources.slice(0, 3) };
  return { ok: false, code: 0, msg: 'Empty response' };
}

let lastAsk = '';
const VERB = {
  'work as': 'works as', 'work at': 'works at',
  'study': 'studies', 'love': 'loves', 'like': 'likes',
  'hate': 'hates', 'prefer': 'prefers', 'enjoy': 'enjoys'
};
const STOP = ['what', 'that', 'this', 'with', 'have', 'your',
  'from', 'tell', 'about', 'please', 'remember', 'there',
  'where', 'when', 'which', 'would', 'could', 'should'];

function recall() {
  const others = chats.filter(c => c.id !== openId);
  if (!others.length) return '';
  let r = 'Past chat topics: ' +
    others.slice(0, 8).map(c => c.title).join(' | ') + '.';
  const words = lastAsk.toLowerCase()
    .split(/[^a-z0-9\u0C00-\u0C7F]+/)
    .filter(w => w.length > 3 && !STOP.includes(w));
  const hits = [];
  others.forEach(c => c.msgs.forEach(m => {
    const t = m.parts[0].text;
    const low = t.toLowerCase();
    if (hits.length < 3 && words.some(w => low.includes(w))) {
      hits.push((m.role === 'user' ? 'User: ' : 'You: ') +
        t.slice(0, 160));
    }
  }));
  if (hits.length) {
    r += ' Related old messages: ' + hits.join(' || ') + '.';
  }
  return r;
}

function sysText() {
  let r = SYSTEM + ' Today is ' +
    new Date().toLocaleString() + '.';
  if (facts.length) {
    r += ' Long-term memory about the user: ' +
      facts.join('; ') + '.';
  }
  const past = recall();
  if (past) r += ' ' + past;
  return r;
}

const stripMem = t => t
  .replace(/\[{1,2}\s*(MEM|FORGET)\s*:[\s\S]*?\]{1,2}/g, '')
  .replace(/\[{1,2}\s*(MEM|FORGET)\s*:[^\]]*$/, '')
  .replace(/\[\[[^\]]*$/, '')
  .replace(/\[$/, '')
  .trim();

function addFact(f) {
  f = f.trim().replace(/\s+/g, ' ');
  if (f.length < 3) return;
  const low = f.toLowerCase();
  if (facts.some(x => x.toLowerCase() === low)) return;
  facts.push(f);
}

function dropFact(term) {
  const low = term.trim().toLowerCase();
  if (low.length < 3) return;
  facts = facts.filter(x => {
    const y = x.toLowerCase();
    return !(y.includes(low) || low.includes(y));
  });
}

function keepFacts() {
  facts = facts.slice(-200);
  store.set('jv_facts', facts);
  refresh();
  if (!$('memPanel').hidden && tab === 'facts') renderMem();
}

function saveFacts(t) {
  const re = /\[{1,2}\s*(MEM|FORGET)\s*:([\s\S]*?)\]{1,2}/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1] === 'MEM') addFact(m[2]); else dropFact(m[2]);
  }
  keepFacts();
}

function localLearn(t) {
  const s = t.trim();
  if (!s || s.slice(-1) === '?') return;
  let m;
  const TE = /గుర్తుంచు\S*|గుర్తు\s?(?:ఉంచు|పెట్టు)\S*/g;
  if ((m = s.match(/^(?:please\s+)?remember(?:\s+that)?[\s:,-]+(.+)/i))) {
    addFact('The user asked to remember: ' + m[1]);
  }
  if (TE.test(s)) {
    addFact('The user asked to remember: ' + s.replace(TE, ''));
  }
  if ((m = s.match(/^forget(?:\s+that|\s+about)?\s+(.+)/i))) {
    dropFact(m[1]);
  }
  if ((m = s.match(/నా పేరు\s+([^\s.,!?]+)/))) {
    addFact('The name of the user is ' + m[1]);
  }
  if ((m = s.match(/\bmy name is ([^.,!?\n]{2,40})/i))) {
    addFact('The name of the user is ' + m[1]);
  }
  if ((m = s.match(/\bi am (\d{1,3}) years? old/i))) {
    addFact('The user is ' + m[1] + ' years old');
  }
  if ((m = s.match(/\bi (?:live|stay) in ([^.,!?\n]{2,40})/i))) {
    addFact('The user lives in ' + m[1]);
  }
  const my = '(favou?rite [a-z ]{2,25}|birthday|mother|father|' +
    'brother|sister|wife|husband|friend|job|goal|dream|plan|' +
    'phone number|email|hobby)';
  if ((m = s.match(new RegExp('\\bmy ' + my +
      ' is ([^.,!?\\n]{1,50})', 'i')))) {
    addFact('The ' + m[1] + ' of the user is ' + m[2]);
  }
  if ((m = s.match(/\bi (work as|work at|study) ([^.,!?\n]{2,40})/i))) {
    addFact('The user ' + VERB[m[1].toLowerCase()] + ' ' + m[2]);
  }
  if ((m = s.match(/\bi (love|like|hate|prefer|enjoy) ([^.,!?\n]{2,40})/i))) {
    addFact('The user ' + VERB[m[1].toLowerCase()] + ' ' + m[2]);
  }
  keepFacts();
}

function shrink(file, max) {
  return new Promise((ok, bad) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => bad(new Error('Bad image'));
    img.src = url;
  });
}

function tabLabels() {
  $('tabChats').textContent = 'CHATS (' + chats.length + ')';
}

function saveChat() {
  if (!history.length) return;
  if (!openId) {
    openId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }
  const i = chats.findIndex(c => c.id === openId);
  let title = i >= 0 ? chats[i].title : '';
  if (!title) {
    const first = history.find(h => h.role === 'user');
    title = (first ? first.parts[0].text : 'Chat').slice(0, 50);
  }
  if (i >= 0) chats.splice(i, 1);
  chats.unshift({
    id: openId, title: title,
    time: Date.now(), msgs: history
  });
  chats = chats.slice(0, 60);
  store.set('jv_chats', chats);
  store.set('jv_open', openId);
  tabLabels();
}

function renderHistory() {
  chat.innerHTML = '';
  history.forEach(h => {
    const isUser = h.role === 'user';
    add((isUser ? 'YOU: ' : 'J.A.R.V.I.S: ') +
      h.parts[0].text, isUser ? 'user' : 'ai');
  });
}

function openChat(id) {
  if (busy) return;
  const c = chats.find(x => x.id === id);
  if (!c) return;
  saveChat();
  openId = c.id;
  history = c.msgs.slice();
  store.set('jv_hist', history);
  store.set('jv_open', openId);
  renderHistory();
  $('memPanel').hidden = true;
  refresh();
}

function deleteChat(id) {
  if (!confirm('Delete this chat?')) return;
  chats = chats.filter(c => c.id !== id);
  if (id === openId) {
    openId = null;
    store.set('jv_open', openId);
  }
  store.set('jv_chats', chats);
  tabLabels();
  renderChats();
}

function renderChats() {
  const box = $('chatList');
  const q = $('chatSearch').value.trim().toLowerCase();
  box.innerHTML = '';
  const list = chats.filter(c => !q ||
    c.title.toLowerCase().includes(q) ||
    c.msgs.some(m => m.parts[0].text.toLowerCase().includes(q)));
  if (!list.length) {
    box.textContent = q ? 'No matching chats.' : 'No chats yet, Boss.';
    return;
  }
  list.forEach(c => {
    const row = document.createElement('div');
    row.className = 'chatrow' + (c.id === openId ? ' cur' : '');
    const ct = document.createElement('div');
    ct.className = 'ct';
    const b = document.createElement('b');
    b.textContent = c.title;
    const sm = document.createElement('small');
    const d = new Date(c.time).toLocaleString([], {
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
    sm.textContent = d + ' · ' + Math.floor(c.msgs.length / 2) +
      ' Q&A' + (c.id === openId ? ' · OPEN' : '');
    ct.appendChild(b);
    ct.appendChild(sm);
    ct.onclick = () => openChat(c.id);
    const x = document.createElement('button');
    x.className = 'ghost';
    x.textContent = '✕';
    x.onclick = () => deleteChat(c.id);
    row.appendChild(ct);
    row.appendChild(x);
    box.appendChild(row);
  });
}

function showTab(t) {
  tab = t;
  $('factsBox').hidden = t !== 'facts';
  $('chatsBox').hidden = t !== 'chats';
  $('tabFacts').classList.toggle('tab-on', t === 'facts');
  $('tabChats').classList.toggle('tab-on', t === 'chats');
  if (t === 'facts') renderMem(); else renderChats();
}

function renderMem() {
  const box = $('memList');
  box.innerHTML = '';
  if (!facts.length) {
    box.textContent = 'Nothing saved yet, Boss.';
    return;
  }
  facts.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'fact';
    const sp = document.createElement('span');
    sp.textContent = f;
    const x = document.createElement('button');
    x.className = 'ghost';
    x.textContent = '✕';
    x.onclick = () => {
      facts.splice(i, 1);
      store.set('jv_facts', facts);
      renderMem();
      refresh();
    };
    row.appendChild(sp);
    row.appendChild(x);
    box.appendChild(row);
  });
}

function say(t) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(
    t.replace(/[*#`_]/g, ''));
  if (/[\u0C00-\u0C7F]/.test(t)) u.lang = 'te-IN';
  u.onstart = () => { speaking = true; };
  u.onend = u.onerror = () => { speaking = false; };
  speechSynthesis.speak(u);
}

let speaking = false;
let timers = store.get('jv_timers', []);
let notes = store.get('jv_notes', []);

const LANGS = {
  telugu: 'te', english: 'en', hindi: 'hi', tamil: 'ta',
  kannada: 'kn', malayalam: 'ml', french: 'fr', spanish: 'es',
  german: 'de', urdu: 'ur', arabic: 'ar', japanese: 'ja',
  chinese: 'zh', korean: 'ko', russian: 'ru'
};

const GOOGLE = 'com.google.android.apps.';
const BASE_APPS = {
  'play store': ['play.google.com/store', 'com.android.vending'],
  'youtube': ['www.youtube.com', 'com.google.android.youtube'],
  'whatsapp': ['wa.me', 'com.whatsapp'],
  'instagram': ['www.instagram.com', 'com.instagram.android'],
  'facebook': ['www.facebook.com', 'com.facebook.katana'],
  'telegram': ['t.me', 'org.telegram.messenger'],
  'twitter': ['twitter.com', 'com.twitter.android'],
  'snapchat': ['www.snapchat.com', 'com.snapchat.android'],
  'linkedin': ['www.linkedin.com', 'com.linkedin.android'],
  'gmail': ['mail.google.com', 'com.google.android.gm'],
  'google maps': ['www.google.com/maps', GOOGLE + 'maps'],
  'google': ['www.google.com', 'com.google.android.googlequicksearchbox'],
  'drive': ['drive.google.com', GOOGLE + 'docs'],
  'photos': ['photos.google.com', GOOGLE + 'photos'],
  'meet': ['meet.google.com', GOOGLE + 'meetings'],
  'calendar': ['calendar.google.com', 'com.google.android.calendar'],
  'spotify': ['open.spotify.com', 'com.spotify.music'],
  'netflix': ['www.netflix.com', 'com.netflix.mediaclient'],
  'hotstar': ['www.hotstar.com', 'in.startv.hotstar'],
  'prime video': ['www.primevideo.com', 'com.amazon.avod.thirdpartyclient'],
  'amazon': ['www.amazon.in', 'in.amazon.mShop.android.shopping'],
  'flipkart': ['www.flipkart.com', 'com.flipkart.android'],
  'swiggy': ['www.swiggy.com', 'in.swiggy.android'],
  'zomato': ['www.zomato.com', 'com.application.zomato'],
  'uber': ['m.uber.com', 'com.ubercab'],
  'phonepe': ['www.phonepe.com', 'com.phonepe.app'],
  'paytm': ['paytm.com', 'net.one97.paytm'],
  'google pay': ['pay.google.com', GOOGLE + 'nbu.paisa.user'],
  'reddit': ['www.reddit.com', 'com.reddit.frontpage'],
  'pinterest': ['www.pinterest.com', 'com.pinterest'],
  'truecaller': ['www.truecaller.com', 'com.truecaller']
};
const APPS = Object.assign({}, BASE_APPS);
const ALIAS = {
  'maps': 'google maps', 'gpay': 'google pay', 'x': '',
  'insta': 'instagram', 'fb': 'facebook', 'prime': 'prime video',
  'యూట్యూబ్': 'youtube', 'వాట్సాప్': 'whatsapp',
  'వాట్సప్': 'whatsapp', 'ప్లే స్టోర్': 'play store',
  'ఇన్స్టాగ్రామ్': 'instagram', 'ఇన్‌స్టాగ్రామ్': 'instagram',
  'టెలిగ్రామ్': 'telegram', 'ఫేస్బుక్': 'facebook',
  'ఫేస్‌బుక్': 'facebook', 'గూగుల్': 'google',
  'మ్యాప్స్': 'google maps', 'జీమెయిల్': 'gmail'
};
Object.keys(ALIAS).forEach(k => {
  if (ALIAS[k]) APPS[k] = BASE_APPS[ALIAS[k]];
});

const CUR = {
  usd: 'USD', dollar: 'USD', dollars: 'USD', inr: 'INR', rupee: 'INR',
  rupees: 'INR', rs: 'INR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP', jpy: 'JPY', yen: 'JPY',
  aed: 'AED', dirham: 'AED', dirhams: 'AED', aud: 'AUD', cad: 'CAD',
  sgd: 'SGD', cny: 'CNY', yuan: 'CNY', sar: 'SAR', riyal: 'SAR',
  chf: 'CHF', krw: 'KRW', pkr: 'PKR', npr: 'NPR', lkr: 'LKR',
  bdt: 'BDT', myr: 'MYR', thb: 'THB'
};

const PIPED = [
  'https://pipedapi.kavin.rocks', 'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru', 'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de', 'https://piped-api.privacy.com.de'
];
const YT_PKG = 'com.google.android.youtube';
const GAME = /^(a |the |some )?(game|chess|riddle|quiz|trivia|with me|20 questions)/i;
const OPEN = /\b(open|launch|start)\b|ఓపెన్|తెరువు|తెరవ/;

function appLink(hostPath, pkg) {
  const web = 'https://' + hostPath;
  if (!/android/i.test(navigator.userAgent)) return web;
  const i = hostPath.indexOf('/');
  const host = i < 0 ? hostPath : hostPath.slice(0, i);
  const path = i < 0 ? '/' : hostPath.slice(i);
  return 'intent://' + host + path + '#Intent;scheme=https;package=' +
    pkg + ';S.browser_fallback_url=' + encodeURIComponent(web) + ';end';
}

function findApp(t, raw) {
  if (!OPEN.test(t) && !OPEN.test(raw)) return null;
  if (t.split(/\s+/).length > 7) return null;
  const keys = Object.keys(APPS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (/^[a-z ]+$/.test(k)) {
      if (new RegExp('\\b' + k + '\\b').test(t)) return k;
    } else if (raw.includes(k)) return k;
  }
  return null;
}

function parseYT(raw, t) {
  const yt = /youtube|యూట్యూబ్/.test(t);
  if (/[\u0C00-\u0C7F]/.test(raw) && /ప్లే|వినిపించు|పెట్టు/.test(raw) &&
      /పాట|సాంగ్|యూట్యూబ్/.test(raw)) {
    const q = raw.replace(/ప్లే చేయి|ప్లే చెయ్|ప్లే|వినిపించు|పెట్టు|యూట్యూబ్‌?లో|యూట్యూబ్|ఓపెన్ చేయి|ఓపెన్|చేయి|ఒక|కొన్ని/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return { q: q || 'తెలుగు పాటలు', play: true };
  }
  let m = t.match(/(?:type|search(?: for)?)\s+(.+?)(?:\s+and\s+(?:then\s+)?play\b.*)?$/);
  if (yt && m) {
    return { q: m[1].replace(/\s+(?:on|in) youtube$/, ''),
      play: /\bplay\b/.test(t) };
  }
  m = t.match(/^(?:please\s+)?play\s+(?:me\s+)?(?:one |a |an |some |any )?(.+?)(?:\s+(?:on|in|from) youtube)?$/);
  if (m) return { q: m[1], play: true };
  m = t.match(/^(?:please\s+)?(?:youtube|search youtube for)\s+(.+)/);
  if (m) return { q: m[1], play: false };
  m = t.match(/^(.+?)\s+(?:on|in) youtube$/);
  if (m) {
    return { q: m[1].replace(/^(?:search|play)\s+/, ''),
      play: /^play\b/.test(t) };
  }
  return null;
}

function firstOk(list) {
  return new Promise(resolve => {
    let left = list.length;
    if (!left) resolve(null);
    list.forEach(p => p.then(v => {
      if (v) resolve(v);
      else if (--left === 0) resolve(null);
    }, () => {
      if (--left === 0) resolve(null);
    }));
  });
}

async function ytFind(q) {
  const many = /songs|music|పాటలు/i.test(q);
  const one = async base => {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 5000);
    try {
      const r = await fetch(base + '/search?filter=videos&q=' +
        encodeURIComponent(q), { signal: c.signal });
      const d = await r.json();
      const list = (d.items || [])
        .filter(x => x.url && x.url.indexOf('/watch?v=') === 0)
        .slice(0, many ? 4 : 1);
      if (!list.length) return null;
      const p = list[Math.floor(Math.random() * list.length)];
      return { id: p.url.split('v=')[1].split('&')[0],
        title: p.title || q };
    } finally {
      clearTimeout(timer);
    }
  };
  return firstOk(PIPED.map(one));
}

async function playSong(q) {
  const v = await ytFind(q);
  if (v) {
    return {
      text: 'Playing "' + v.title + '" on YouTube, Boss.',
      url: appLink('www.youtube.com/watch?v=' + v.id, YT_PKG),
      label: '▶ PLAY ON YOUTUBE',
      auto: true
    };
  }
  return {
    text: 'Opening YouTube for ' + q + ', Boss. Pick a song.',
    url: appLink('www.youtube.com/results?search_query=' +
      encodeURIComponent(q), YT_PKG),
    label: '▶ OPEN YOUTUBE',
    auto: true
  };
}

let torch = null;
async function flashlight(on) {
  if (!on) {
    if (torch) torch.getTracks().forEach(x => x.stop());
    torch = null;
    return 'Flashlight is off, Boss.';
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'Flashlight is not available in this browser, Boss.';
  }
  try {
    const st = await navigator.mediaDevices.getUserMedia(
      { video: { facingMode: 'environment' } });
    const tr = st.getVideoTracks()[0];
    const caps = tr.getCapabilities ? tr.getCapabilities() : {};
    if (!caps.torch) {
      st.getTracks().forEach(x => x.stop());
      return 'This phone or browser does not allow the flashlight ' +
        'from a web page, Boss.';
    }
    await tr.applyConstraints({ advanced: [{ torch: true }] });
    torch = st;
    return 'Flashlight is on, Boss. Say "flashlight off" to turn it off.';
  } catch (e) {
    return 'I need camera permission for the flashlight, Boss.';
  }
}

async function currency(amount, from, to) {
  try {
    const r = await (await fetch(
      'https://open.er-api.com/v6/latest/' + from)).json();
    if (!r.rates || !r.rates[to]) return 'Currency service error, Boss.';
    const v = Math.round(amount * r.rates[to] * 100) / 100;
    return amount + ' ' + from + ' = ' + v + ' ' + to +
      ' (live rate), Boss.';
  } catch (e) {
    return 'Currency service error, Boss.';
  }
}

async function cityTime(city) {
  try {
    const g = await (await fetch(
      'https://geocoding-api.open-meteo.com/v1/search?count=1&name=' +
      encodeURIComponent(city))).json();
    if (!g.results || !g.results.length) {
      return 'I could not find ' + city + ', Boss.';
    }
    const z = g.results[0];
    const now = new Date();
    return 'In ' + z.name + ' it is ' +
      now.toLocaleTimeString([], { timeZone: z.timezone }) + ', ' +
      now.toLocaleDateString([], {
        timeZone: z.timezone, weekday: 'long',
        day: 'numeric', month: 'long'
      }) + ', Boss.';
  } catch (e) {
    return 'Time service error, Boss.';
  }
}

async function whereAmI() {
  try {
    const p = await getPos();
    const lat = p.coords.latitude, lon = p.coords.longitude;
    const name = await placeName(lat, lon);
    return {
      text: 'You are in ' + (name || 'an unknown place') + ' (' +
        lat.toFixed(4) + ', ' + lon.toFixed(4) + '), Boss.',
      url: appLink('www.google.com/maps/search/?api=1&query=' +
        lat + ',' + lon, GOOGLE + 'maps'),
      label: 'OPEN IN MAPS'
    };
  } catch (e) {
    if (e && e.code) return 'I need location permission, Boss.';
    return 'I could not get your location, Boss.';
  }
}

const LIVE = /\b(news|headlines|latest|scores?|stocks?|sensex|nifty|price of|prices?|gold rate|silver rate|petrol|diesel|bitcoin|crypto|ipl|who won|trending|breaking|election results?|box office|release date)\b|వార్తలు|ధర|స్కోర్|తాజా/i;
const needsLive = t => LIVE.test(t);

function srcLine(src) {
  return src && src.length ? '\n\nSources: ' + src.join(', ') : '';
}

const TOOLS_HELP = 'My tools, Boss:\n' +
  '- weather report (uses your location), air quality, where am I\n' +
  '- time, date, time in London\n' +
  '- open YouTube / Play Store / WhatsApp / Instagram ... any app\n' +
  '- play telugu songs, search telugu songs on youtube\n' +
  '- install <app>, navigate to <place>, google <text>\n' +
  '- call <number>, sms <number> <text>, whatsapp <number> <text>\n' +
  '- open camera, flashlight on / off\n' +
  '- timer 5 minutes, remind me in 10 minutes to call mom\n' +
  '- translate good morning to Hindi, 100 usd to inr\n' +
  '- 25*4+10, 15% of 200, battery\n' +
  '- flip a coin, roll a dice, random number 1 to 50\n' +
  '- take a note <text>, show notes, clear notes\n' +
  '- generate an image of a sunset over hills\n' +
  '- make a pdf about <topic>, make this a pdf\n' +
  '- make an excel / csv of <topic>\n' +
  '- wake mode: tap WAKE, then say Hey Jarvis\n' +
  '- news, scores, prices: ask normally and I search live';

function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = new AC();
    if (c.resume) c.resume();
    [0, 0.35, 0.7].forEach(d => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(c.destination);
      g.gain.setValueAtTime(0.2, c.currentTime + d);
      o.start(c.currentTime + d);
      o.stop(c.currentTime + d + 0.25);
    });
    setTimeout(() => { try { c.close(); } catch (e) {} }, 1500);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

function ring(msg) {
  beep();
  add('J.A.R.V.I.S: ' + msg, 'ai');
  say(msg);
}

function armTimer(t) {
  const fire = () => {
    timers = timers.filter(x => x.id !== t.id);
    store.set('jv_timers', timers);
    ring(t.msg);
  };
  const left = t.end - Date.now();
  if (left <= 0) fire();
  else setTimeout(fire, Math.min(left, 2147483647));
}

function wcode(c) {
  if (c === 0) return ['clear sky', 'నిర్మలమైన ఆకాశం'];
  if (c <= 3) return ['partly cloudy', 'పాక్షికంగా మేఘావృతం'];
  if (c <= 48) return ['foggy', 'పొగమంచు'];
  if (c <= 57) return ['drizzle', 'చినుకులు'];
  if (c <= 67) return ['rain', 'వర్షం'];
  if (c <= 77) return ['snow', 'మంచు'];
  if (c <= 82) return ['rain showers', 'జల్లులు'];
  if (c <= 86) return ['snow showers', 'మంచు జల్లులు'];
  return ['thunderstorm', 'ఉరుములతో వర్షం'];
}

function t12(x) {
  const p = String(x).slice(11, 16).split(':');
  const h = +p[0];
  return (h % 12 || 12) + ':' + p[1] + ' ' + (h >= 12 ? 'PM' : 'AM');
}

function aqiName(v) {
  if (v <= 50) return 'Good';
  if (v <= 100) return 'Moderate';
  if (v <= 150) return 'Unhealthy for sensitive groups';
  if (v <= 200) return 'Unhealthy';
  if (v <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function getPos() {
  return new Promise((ok, bad) => {
    if (!navigator.geolocation) bad(new Error('nogeo'));
    else navigator.geolocation.getCurrentPosition(ok, bad, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 60000
    });
  });
}

async function placeName(lat, lon) {
  try {
    const d = await (await fetch(
      'https://api.bigdatacloud.net/data/reverse-geocode-client' +
      '?localityLanguage=en&latitude=' + lat +
      '&longitude=' + lon)).json();
    return [d.locality || d.city, d.principalSubdivision]
      .filter(Boolean).join(', ');
  } catch (e) {
    return '';
  }
}

async function weather(city, te) {
  try {
    let lat, lon, place = '';
    if (city) {
      const g = await (await fetch(
        'https://geocoding-api.open-meteo.com/v1/search?count=1&name=' +
        encodeURIComponent(city))).json();
      if (!g.results || !g.results.length) {
        return 'I could not find ' + city + ', Boss.';
      }
      const z = g.results[0];
      lat = z.latitude;
      lon = z.longitude;
      place = z.name + (z.admin1 ? ', ' + z.admin1 : '');
    } else {
      const p = await getPos();
      lat = p.coords.latitude;
      lon = p.coords.longitude;
      place = await placeName(lat, lon);
    }
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' +
      lat + '&longitude=' + lon + '&timezone=auto&forecast_days=1' +
      '&current=temperature_2m,apparent_temperature,' +
      'relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,' +
      'precipitation_probability_max,uv_index_max,sunrise,sunset';
    const aqUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality' +
      '?latitude=' + lat + '&longitude=' + lon + '&current=us_aqi';
    const both = await Promise.all([
      fetch(url).then(r => r.json()),
      fetch(aqUrl).then(r => r.json()).catch(() => null)
    ]);
    const c = both[0].current, day = both[0].daily;
    const aq = both[1] && both[1].current && both[1].current.us_aqi;
    const w = wcode(c.weather_code);
    const R = Math.round;
    const rain = day.precipitation_probability_max[0];
    const rainTxt = rain === null || rain === undefined ? '-' : rain + '%';
    const where = place || (te ? 'మీ ప్రదేశం' : 'your location');
    if (te) {
      return where + ' వాతావరణం ఇప్పుడు:\n' +
        R(c.temperature_2m) + ' °C (అనుభూతి ' +
        R(c.apparent_temperature) + ' °C), ' + w[1] + '\n' +
        'తేమ ' + c.relative_humidity_2m + '%, గాలి ' +
        c.wind_speed_10m + ' కి.మీ/గం\n' +
        'ఈ రోజు: గరిష్టం ' + R(day.temperature_2m_max[0]) +
        ' °C, కనిష్టం ' + R(day.temperature_2m_min[0]) +
        ' °C, వర్షం అవకాశం ' + rainTxt + '\n' +
        'సూర్యోదయం ' + t12(day.sunrise[0]) +
        ', సూర్యాస్తమయం ' + t12(day.sunset[0]) +
        (aq === null || aq === undefined ? '' :
          '\nగాలి నాణ్యత (AQI): ' + R(aq) + ' - ' + aqiName(aq));
    }
    return 'Weather in ' + where + ' now, Boss:\n' +
      R(c.temperature_2m) + ' °C (feels like ' +
      R(c.apparent_temperature) + ' °C), ' + w[0] + '\n' +
      'Humidity ' + c.relative_humidity_2m + '%, wind ' +
      c.wind_speed_10m + ' km/h\n' +
      'Today: high ' + R(day.temperature_2m_max[0]) + ' °C, low ' +
      R(day.temperature_2m_min[0]) + ' °C, rain chance ' + rainTxt +
      ', UV ' + R(day.uv_index_max[0]) + '\n' +
      'Sunrise ' + t12(day.sunrise[0]) + ', sunset ' +
      t12(day.sunset[0]) +
      (aq === null || aq === undefined ? '' :
        '\nAir quality: ' + R(aq) + ' (' + aqiName(aq) + ')');
  } catch (e) {
    if (e && e.message === 'nogeo') {
      return 'This browser has no location service, Boss.';
    }
    if (e && e.code === 1) {
      return 'I need location permission for weather, Boss. Tap the ' +
        'lock icon next to the address, allow Location, and try again.';
    }
    if (e && e.code) {
      return 'I could not get your location, Boss. Turn on GPS.';
    }
    return 'Weather service error, Boss.';
  }
}

function mathAnswer(raw) {
  let e = raw.toLowerCase()
    .replace(/^(please\s+)?(calculate|calc|compute|solve|what is|what's)\s+/, '')
    .replace(/[?=]+$/, '').trim();
  e = e.replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*of\s*(\d+(?:\.\d+)?)/g,
      '($1/100*$2)')
    .replace(/\bplus\b/g, '+')
    .replace(/\bminus\b/g, '-')
    .replace(/\b(?:times|multiplied by|into)\b/g, '*')
    .replace(/(\d)\s*x\s*(\d)/g, '$1*$2')
    .replace(/\b(?:divided by|over)\b/g, '/')
    .replace(/\b(?:to the power of|power)\b/g, '**')
    .replace(/\^/g, '**')
    .replace(/(\d),(\d{3})/g, '$1$2');
  if (!/^[0-9+\-*/().\s]+$/.test(e)) return null;
  if (!/\d/.test(e) || !/[+\-*/]/.test(e.replace(/^\s*-/, ''))) {
    return null;
  }
  try {
    const v = Function('"use strict";return (' + e + ')')();
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return e.trim() + ' = ' + Math.round(v * 1e10) / 1e10 + ', Boss.';
  } catch (err) {
    return null;
  }
}

const PDF_ASK = 'Write a clear, well organised document about: ';
const PDF_RULES = '. Reply in the same language as the topic. Use "# " ' +
  'for the title, "## " for section headings, "- " for bullet points ' +
  'and plain paragraphs. No tables, no code blocks, no other markdown.';

function lastReply() {
  const r = history.slice().reverse().find(h => h.role === 'model');
  return r ? r.parts[0].text : '';
}

function slug(x) {
  const v = x.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  return v || 'jarvis-file';
}

async function geminiText(prompt) {
  const list = (model ? [model] : [])
    .concat(FALLBACK.filter(m => m !== model));
  let err = '';
  for (const m of list) {
    const res = await fetch(BASE + 'models/' + m +
      ':generateContent?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await res.json();
    if (res.ok) {
      const c = d.candidates && d.candidates[0];
      const p = c && c.content && c.content.parts;
      const t = p ? p.map(x => x.text || '').join('').trim() : '';
      if (t) return stripMem(t);
      err = 'Empty answer';
      continue;
    }
    err = d.error ? d.error.message : 'HTTP ' + res.status;
    if ([400, 401, 403].includes(res.status)) break;
  }
  throw new Error(err);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function loadImg(src) {
  return new Promise((ok, bad) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => bad(new Error('image'));
    i.src = src;
  });
}

async function imageModels() {
  let found = [];
  try {
    const d = await (await fetch(BASE + 'models?pageSize=200&key=' +
      encodeURIComponent(apiKey))).json();
    found = (d.models || [])
      .filter(m => /gemini.*image/.test(m.name) &&
        (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.slice(7))
      .sort((a, b) => (/lite/.test(b) ? 1 : 0) - (/lite/.test(a) ? 1 : 0));
  } catch (e) {}
  const base = ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image',
    'gemini-2.5-flash-image'];
  return found.concat(base.filter(x => !found.includes(x))).slice(0, 4);
}

async function makeImage(prompt) {
  let err = '';
  for (const m of await imageModels()) {
    try {
      const res = await fetch(BASE + 'models/' + m +
        ':generateContent?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Create an image: ' + prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        })
      });
      const d = await res.json();
      if (res.ok) {
        const c = d.candidates && d.candidates[0];
        const parts = (c && c.content && c.content.parts) || [];
        const p = parts.find(x => x.inlineData && x.inlineData.data);
        if (p) {
          return { src: 'data:' + (p.inlineData.mimeType || 'image/png') +
            ';base64,' + p.inlineData.data, model: m };
        }
        err = 'No image in the answer';
      } else {
        err = d.error ? d.error.message : 'HTTP ' + res.status;
      }
    } catch (e) {
      err = e.message;
    }
  }
  return { err: err };
}

async function imageTool(prompt) {
  if (!apiKey) return 'Please set your API key first (tap API KEY), Boss.';
  const r = await makeImage(prompt);
  if (r.src) {
    const blob = new Blob([b64ToBytes(r.src.split(',')[1])],
      { type: 'image/png' });
    return {
      text: 'Here is your image, Boss.',
      img: r.src,
      file: { url: URL.createObjectURL(blob),
        name: slug(prompt) + '.png', label: '⬇ DOWNLOAD IMAGE' }
    };
  }
  let en = prompt;
  if (/[^\u0000-\u007f]/.test(prompt)) {
    try {
      en = await geminiText('Translate into one short English image ' +
        'prompt. Output only the prompt: ' + prompt);
    } catch (e) {}
  }
  const url = 'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(en) + '?width=768&height=768&nologo=true&seed=' +
    Math.floor(Math.random() * 1000000);
  return {
    text: 'Here is your image, Boss. Gemini image models were not ' +
      'available on this key (' + String(r.err).slice(0, 90) +
      '), so I used a free image service.',
    img: url,
    url: url,
    label: 'OPEN / SAVE IMAGE'
  };
}

async function buildPdf(body, imgSrc) {
  const W = 794, H = 1123, M = 56;
  const FONT = 'system-ui, "Noto Sans Telugu", "Noto Sans", Arial, sans-serif';
  const pages = [];
  let c, g, y;
  const fontOf = (size, bold) => (bold ? 'bold ' : '') + size + 'px ' + FONT;
  const newPage = () => {
    c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#111111';
    g.textBaseline = 'alphabetic';
    y = M;
    pages.push(c);
  };
  const put = (text, size, bold, indent, gap) => {
    const maxW = W - 2 * M - indent;
    g.font = fontOf(size, bold);
    const lines = [];
    let line = '';
    text.split(/\s+/).forEach(w => {
      const t = line ? line + ' ' + w : w;
      if (line && g.measureText(t).width > maxW) {
        lines.push(line);
        line = w;
      } else {
        line = t;
      }
    });
    if (line) lines.push(line);
    lines.forEach(l => {
      if (y + size * 1.5 > H - M) {
        newPage();
        g.font = fontOf(size, bold);
      }
      g.fillText(l, M + indent, y + size);
      y += size * 1.5;
    });
    y += gap;
  };
  newPage();
  if (imgSrc) {
    try {
      const im = await loadImg(imgSrc);
      const w = Math.min(W - 2 * M, im.width);
      const h = im.height * w / im.width;
      g.drawImage(im, M, y, w, h);
      y += h + 18;
    } catch (e) {}
  }
  body.split('\n').forEach(raw => {
    const l = raw.replace(/\*\*|`/g, '').trim();
    if (!l) { y += 6; return; }
    let m;
    if ((m = l.match(/^#\s+(.+)/))) put(m[1], 30, true, 0, 10);
    else if ((m = l.match(/^##\s+(.+)/))) put(m[1], 23, true, 0, 6);
    else if ((m = l.match(/^#{3,}\s+(.+)/))) put(m[1], 19, true, 0, 4);
    else if ((m = l.match(/^[-*•]\s+(.+)/))) put('• ' + m[1], 17, false, 16, 2);
    else put(l.replace(/^\*\s*/, ''), 17, false, 0, 6);
  });
  pages.forEach((cv, i) => {
    const x = cv.getContext('2d');
    x.fillStyle = '#888888';
    x.font = '12px ' + FONT;
    x.fillText('J.A.R.V.I.S  -  page ' + (i + 1) + ' of ' + pages.length,
      M, H - 24);
  });
  const enc = new TextEncoder();
  const parts = [];
  const offs = [];
  let len = 0;
  const add = x => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    parts.push(b);
    len += b.length;
  };
  const obj = (n, text) => {
    offs[n] = len;
    add(n + ' 0 obj\n' + text + '\nendobj\n');
  };
  add('%PDF-1.4\n');
  const n = pages.length;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [' +
    pages.map((p, i) => (3 + i * 3) + ' 0 R').join(' ') +
    '] /Count ' + n + ' >>');
  pages.forEach((cv, i) => {
    const p = 3 + i * 3, ct = p + 1, im = p + 2;
    const jpg = b64ToBytes(cv.toDataURL('image/jpeg', 0.85).split(',')[1]);
    obj(p, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /XObject << /Im0 ' + im + ' 0 R >> >> ' +
      '/Contents ' + ct + ' 0 R >>');
    const draw = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    obj(ct, '<< /Length ' + draw.length + ' >>\nstream\n' + draw +
      '\nendstream');
    offs[im] = len;
    add(im + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + W +
      ' /Height ' + H + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 ' +
      '/Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n');
    add(jpg);
    add('\nendstream\nendobj\n');
  });
  const total = 3 + n * 3;
  const xref = len;
  let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let i = 1; i < total; i++) {
    x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  }
  add(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' +
    xref + '\n%%EOF');
  return { blob: new Blob(parts, { type: 'application/pdf' }), pages: n };
}

async function pdfTool(topic, fromChat, wantImg) {
  if (!apiKey) return 'Please set your API key first (tap API KEY), Boss.';
  const text = fromChat || await geminiText(PDF_ASK + topic + PDF_RULES);
  let imgSrc = '';
  if (wantImg) {
    const r = await makeImage(topic || 'illustration');
    if (r.src) imgSrc = r.src;
  }
  const h = text.split('\n').find(l => /^#\s+/.test(l));
  const title = h ? h.replace(/^#\s+/, '').trim() :
    (topic || 'J.A.R.V.I.S document').slice(0, 60);
  const out = await buildPdf(text, imgSrc);
  return {
    text: 'Your PDF is ready, Boss: ' + title + ' (' + out.pages +
      (out.pages === 1 ? ' page)' : ' pages)') +
      (wantImg && !imgSrc ? '. I could not add the image.' : '.'),
    file: { url: URL.createObjectURL(out.blob),
      name: slug(title) + '.pdf', label: '⬇ DOWNLOAD PDF' }
  };
}

async function csvTool(topic) {
  if (!apiKey) return 'Please set your API key first (tap API KEY), Boss.';
  let t = await geminiText('Create a CSV table (first row = headers) ' +
    'for: ' + topic + '. Output only raw CSV text, no markdown fences, ' +
    'no explanation. Reply in the same language as the topic.');
  t = t.replace(/^```[a-z]*\n?|```$/g, '').trim();
  const blob = new Blob(['\ufeff' + t], { type: 'text/csv;charset=utf-8' });
  return {
    text: 'Your spreadsheet (CSV) is ready, Boss. It opens in Excel and ' +
      'Google Sheets.\n\n' + t.split('\n').slice(0, 6).join('\n'),
    file: { url: URL.createObjectURL(blob),
      name: slug(topic) + '.csv', label: '⬇ DOWNLOAD EXCEL (CSV)' }
  };
}

function matchTool(text) {
  const raw = text.trim();
  const t = raw.toLowerCase();
  const te = /[\u0C00-\u0C7F]/.test(raw);
  const words = t.split(/\s+/).length;
  let m;

  if (/^(help|tools|what can you do)\b/.test(t) ||
      /టూల్స్|ఏం చేయగలవు/.test(raw)) {
    return async () => TOOLS_HELP;
  }

  const MAKE = /\b(make|create|generate|write|prepare|build|convert|save|export|give me|draw|paint|design)\b|చేయి|తయారు|రాయి|గీయి|క్రియేట్|జనరేట్/;
  const both = t + ' ' + raw;
  const IMGW = /\b(image|picture|photo|pic|logo|poster|wallpaper|illustration|drawing|painting|sketch|art)\b|చిత్రం|బొమ్మ|ఫోటో|పోస్టర్|లోగో/;
  const topicOf = () => {
    let x = '';
    const a = raw.match(/\b(?:about|on|regarding|of|for)\s+(.+?)(?:\s+(?:as|in|into)\s+(?:a\s+)?(?:pdf|excel|csv|spreadsheet))?[.!?]*$/i);
    if (a) x = a[1];
    const g = raw.match(/^(.+?)\s*గురించి/);
    if (g) x = g[1];
    if (!x) {
      x = raw.replace(/\b(please|can you|could you|make|create|generate|write|prepare|build|convert|save|export|give|me|a|an|the|pdf|excel|csv|spreadsheet|sheet|file|document|about|on|of|for|regarding|in|as|into|this|that|it)\b/gi, ' ')
        .replace(/పీడీఎఫ్|చేయి|తయారు|రాయి/g, ' ')
        .replace(/\s+/g, ' ').trim();
    }
    return x;
  };

  if (MAKE.test(both) && /\bpdf\b|పీడీఎఫ్/.test(both)) {
    const topic = topicOf();
    const last = lastReply();
    const wantImg = IMGW.test(both);
    if (topic.length < 3 && !last) {
      return async () => 'What should the PDF be about, Boss?';
    }
    return () => pdfTool(topic.length < 3 ? '' : topic,
      topic.length < 3 ? last : '', wantImg);
  }

  if (MAKE.test(both) && /\b(excel|csv|spreadsheet)\b/.test(both)) {
    const topic = topicOf();
    if (topic.length < 3) {
      return async () => 'What should the spreadsheet be about, Boss?';
    }
    return () => csvTool(topic);
  }

  m = raw.match(/^(?:please\s+)?(?:draw|paint|sketch)\s+(?:me\s+)?(.+)/i);
  if (!m && MAKE.test(both) && IMGW.test(both) &&
      !/\b(this|my|above|attached) (image|picture|photo)\b/.test(t)) {
    const p = raw.replace(/^(please\s+)?(can you\s+)?(make|create|generate|design|show)\s+(me\s+)?(an?\s+)?(image|picture|photo|pic|logo|poster|wallpaper|illustration|drawing|painting|sketch|art)?\s*(of|about|showing|with|for)?\s*/i, '')
      .replace(/గీయి|గీయండి|తయారు చేయి|క్రియేట్ చేయి|జనరేట్ చేయి|చేయి/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const q = p.length > 2 ? p : raw;
    return () => imageTool(q);
  }
  if (m) return () => imageTool(m[1].trim());

  m = t.match(/\b(?:time|date)\s+(?:in|at)\s+([a-z .'-]{2,40})$/);
  if (m) return () => cityTime(m[1].trim());

  if (/\b(where am i|my location|current location|where i am)\b/.test(t) ||
      /నేను ఎక్కడ|నా లొకేషన్|నా లోకేషన్/.test(raw)) {
    return () => whereAmI();
  }

  if (/\b(what('s| is)?( the)? (current )?time|current time|time now|time is it|tell me the time)\b/.test(t) ||
      /^time[?!. ]*$/.test(t) ||
      /టైమ్ ఎంత|టైం ఎంత|సమయం ఎంత|ఇప్పుడు టైమ్|ఇప్పుడు సమయం/.test(raw)) {
    return async () =>
      'The time is ' + new Date().toLocaleTimeString() + ', Boss.';
  }

  if (/\b(today'?s? date|what('s| is)?( the)? date|what day (is it|is today)|which day)\b/.test(t) ||
      /తేదీ ఎంత|ఈ రోజు తేదీ|ఈరోజు తేదీ|ఈ రోజు ఏ రోజు/.test(raw)) {
    return async () => 'Today is ' +
      new Date().toLocaleDateString([], {
        weekday: 'long', day: 'numeric',
        month: 'long', year: 'numeric'
      }) + ', Boss.';
  }

  if ((/\b(weather|temperature|forecast|aqi|air quality|pollution)\b/.test(t) &&
      !/\b(explain|why|how does|how do|what causes|define)\b/.test(t)) ||
      /వాతావరణం|ఉష్ణోగ్రత/.test(raw)) {
    const c = t.match(
      /(?:weather|temperature|forecast|aqi|air quality)\s+(?:in|at|of|for)\s+([a-z .'-]{2,40})/);
    return () => weather(c ? c[1].trim() : '', te);
  }

  const tm = t.match(
    /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|సెకన్\S*|సెకను\S*|సెకెండ్\S*|నిమిషా\S*|నిమిషం\S*|గంట\S*)/);
  if (tm && (/\b(timer|remind me)\b/.test(t) || /టైమర్/.test(raw))) {
    const amount = parseFloat(tm[1]);
    const unit = tm[2];
    const factor = /^(hours?|hrs?|గంట)/.test(unit) ? 3600000 :
      /^(seconds?|secs?|సెక)/.test(unit) ? 1000 : 60000;
    const ms = amount * factor;
    if (!(ms > 0) || ms > 86400000) {
      return async () => 'Timers can be from 1 second to 24 hours, Boss.';
    }
    const rm = raw.match(/remind me.*?\bto\s+(.+)$/i);
    const msg = rm ? 'Reminder, Boss: ' + rm[1] :
      te ? 'టైమర్ పూర్తైంది! ' + amount + ' ' + unit + ' అయ్యాయి.' :
      'Timer finished, Boss! ' + amount + ' ' + unit + ' are up.';
    return async () => {
      const id = Date.now();
      const tmr = { id: id, end: id + ms, msg: msg };
      timers.push(tmr);
      store.set('jv_timers', timers);
      armTimer(tmr);
      return 'Timer set for ' + amount + ' ' + unit +
        ', Boss. Keep this page open for the alarm.';
    };
  }

  if (/\btranslate\b/.test(t) || /అనువదించు/.test(raw)) {
    return async () => {
      let q = raw.replace(/translate( this)?( sentence| text| word)?[:,]?/i, '')
        .replace(/అనువదించు\S*/g, '').trim();
      let target = '';
      const lm = q.match(/\s+(?:to|in|into)\s+([a-z]+)\s*$/i);
      if (lm && LANGS[lm[1].toLowerCase()]) {
        target = LANGS[lm[1].toLowerCase()];
        q = q.slice(0, lm.index).trim();
      }
      q = q.replace(/^["'“”]+|["'“”]+$/g, '').trim() || 'hello';
      const src = /[\u0C00-\u0C7F]/.test(q) ? 'te' :
        /[\u0900-\u097F]/.test(q) ? 'hi' : 'en';
      if (!target) target = src === 'en' ? 'te' : 'en';
      if (src === target) return 'That is already in that language, Boss.';
      try {
        const r = await fetch(
          'https://api.mymemory.translated.net/get?q=' +
          encodeURIComponent(q) + '&langpair=' +
          encodeURIComponent(src + '|' + target));
        const d = await r.json();
        const out = d.responseData && d.responseData.translatedText;
        if (!out || Number(d.responseStatus) !== 200) {
          return 'Translate error, Boss.';
        }
        const name = Object.keys(LANGS).find(k => LANGS[k] === target);
        return 'In ' + name.charAt(0).toUpperCase() + name.slice(1) +
          ': ' + out;
      } catch (e) {
        return 'Translate error, Boss.';
      }
    };
  }

  m = raw.match(/^(?:please\s+)?(?:send\s+)?(?:a\s+)?whatsapp(?:\s+message)?(?:\s+to)?\s+(\+?\d[\d\s-]{8,14})\s*(?:saying|message|:)?\s*(.*)$/i);
  if (m) {
    let num = m[1].replace(/\D/g, '');
    if (num.length === 10) num = '91' + num;
    const msg = m[2].trim();
    return async () => ({
      text: 'Opening WhatsApp chat with +' + num + ', Boss.',
      url: appLink('wa.me/' + num + (msg ? '?text=' +
        encodeURIComponent(msg) : ''), 'com.whatsapp'),
      label: 'OPEN WHATSAPP',
      auto: true
    });
  }

  m = raw.match(/^(?:please\s+)?(?:send\s+)?(?:an\s+)?sms(?:\s+to)?\s+(\+?\d[\d\s-]{5,14})\s*(?:saying|message|:)?\s*(.*)$/i);
  if (m) {
    const num = m[1].replace(/[\s-]/g, '');
    return async () => ({
      text: 'Ready to send an SMS to ' + num + ', Boss.',
      url: 'sms:' + num + (m[2].trim() ? '?body=' +
        encodeURIComponent(m[2].trim()) : ''),
      label: 'OPEN SMS'
    });
  }

  m = raw.match(/^(?:please\s+)?(?:call|dial)\s+(\+?\d[\d\s-]{2,14})$/i);
  if (m) {
    const num = m[1].replace(/[\s-]/g, '');
    return async () => ({
      text: 'Ready to call ' + num + ', Boss. Tap the button.',
      url: 'tel:' + num,
      label: 'CALL ' + num
    });
  }

  if (/\b(open|start)\s+(the\s+)?camera\b|take a (photo|picture|pic)\b|కెమెరా ఓపెన్|ఫోటో తీ/.test(t + ' ' + raw)) {
    return async () => ({
      text: 'Tap the button to open the camera, Boss. ' +
        'I will look at the photo.',
      label: '📷 OPEN CAMERA',
      click: () => $('file').click()
    });
  }

  if (/\b(flash ?light|torch)\b|టార్చ్|ఫ్లాష్/.test(t + ' ' + raw)) {
    const off = /\boff\b|ఆఫ్/.test(t + ' ' + raw);
    return () => flashlight(!off);
  }

  m = t.match(/(\d+(?:\.\d+)?)\s*([a-z]{2,8})\s+(?:to|in|into)\s+([a-z]{2,8})\b/);
  if (m && CUR[m[2]] && CUR[m[3]] && CUR[m[2]] !== CUR[m[3]]) {
    return () => currency(parseFloat(m[1]), CUR[m[2]], CUR[m[3]]);
  }

  const yt = parseYT(raw, t);
  if (yt && !GAME.test(yt.q) && !/^store\b/.test(yt.q)) {
    const q = yt.q;
    if (yt.play) return () => playSong(q);
    return async () => ({
      text: 'Searching YouTube for ' + q + ', Boss.',
      url: appLink('www.youtube.com/results?search_query=' +
        encodeURIComponent(q), YT_PKG),
      label: '▶ OPEN YOUTUBE',
      auto: true
    });
  }

  m = t.match(/^(?:please\s+)?(?:install|download)\s+(.+?)(?:\s+app)?$/);
  if (m && !/\b(movie|song|video|file)\b/.test(m[1])) {
    return async () => ({
      text: 'Searching the Play Store for ' + m[1] + ', Boss.',
      url: appLink('play.google.com/store/search?c=apps&q=' +
        encodeURIComponent(m[1]), 'com.android.vending'),
      label: 'OPEN PLAY STORE',
      auto: true
    });
  }

  const app = findApp(t, raw);
  if (app) {
    const sr = t.match(/(?:search|find|type)\s+(.+)$/);
    const pair = APPS[app];
    const name = app.replace(/\b\w/g, c => c.toUpperCase());
    if (app === 'play store' && sr) {
      return async () => ({
        text: 'Searching the Play Store for ' + sr[1] + ', Boss.',
        url: appLink('play.google.com/store/search?c=apps&q=' +
          encodeURIComponent(sr[1]), 'com.android.vending'),
        label: 'OPEN PLAY STORE',
        auto: true
      });
    }
    return async () => ({
      text: 'Opening ' + name + ', Boss.',
      url: appLink(pair[0], pair[1]),
      label: 'OPEN ' + name.toUpperCase(),
      auto: true
    });
  }

  m = t.match(/^(?:please\s+)?open\s+(.+)$/);
  if (m && m[1].split(/\s+/).length <= 4) {
    const x = m[1].trim();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(x)) {
      return async () => ({
        text: 'Opening ' + x + ', Boss.',
        url: 'https://' + x,
        label: 'OPEN ' + x.toUpperCase(),
        auto: true
      });
    }
    if (/^(the )?(phone|dialer)$/.test(x)) {
      return async () => ({
        text: 'Tap to open the phone dialer, Boss.',
        url: 'tel:',
        label: 'OPEN DIALER'
      });
    }
    if (/^(the )?(messages|sms)$/.test(x)) {
      return async () => ({
        text: 'Tap to open messages, Boss.',
        url: 'sms:',
        label: 'OPEN MESSAGES'
      });
    }
    if (/^(the )?(settings|clock|alarm|calculator|gallery|contacts|files)$/.test(x)) {
      return async () => 'Android does not let a web page open that ' +
        'system app, Boss. Please open it from your home screen.';
    }
    return async () => ({
      text: 'I do not know that app yet, Boss. Searching the Play Store.',
      url: appLink('play.google.com/store/search?c=apps&q=' +
        encodeURIComponent(x), 'com.android.vending'),
      label: 'OPEN PLAY STORE'
    });
  }

  m = raw.match(/^(?:please\s+)?(?:google|search google for)\s+(.+)/i);
  if (m) {
    return async () => ({
      text: 'Searching Google for ' + m[1] + ', Boss.',
      url: 'https://www.google.com/search?q=' + encodeURIComponent(m[1]),
      label: 'OPEN GOOGLE',
      auto: true
    });
  }

  m = raw.match(/^(?:please\s+)?(?:navigate to|directions to|take me to|show map of|route to)\s+(.+)/i);
  if (m) {
    return async () => ({
      text: 'Finding ' + m[1] + ' on the map, Boss.',
      url: appLink('www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(m[1]), GOOGLE + 'maps'),
      label: 'OPEN MAPS',
      auto: true
    });
  }

  const ma = mathAnswer(raw);
  if (ma !== null) return async () => ma;

  if (/\bbattery\b|బ్యాటరీ/.test(t) && words <= 6) {
    return async () => {
      if (!navigator.getBattery) {
        return 'Battery info is not available in this browser, Boss.';
      }
      const b = await navigator.getBattery();
      return 'Battery is at ' + Math.round(b.level * 100) + '%' +
        (b.charging ? ' and charging' : '') + ', Boss.';
    };
  }

  if (/\b(flip|toss)( a)? coin\b/.test(t)) {
    return async () => (Math.random() < 0.5 ? 'Heads' : 'Tails') + ', Boss.';
  }
  if (/\broll( a)? (dice|die)\b/.test(t)) {
    return async () => 'You rolled a ' +
      (1 + Math.floor(Math.random() * 6)) + ', Boss.';
  }
  m = t.match(/random number (?:between|from) (\d+) (?:and|to) (\d+)/);
  if (m) {
    const lo = Math.min(+m[1], +m[2]);
    const hi = Math.max(+m[1], +m[2]);
    return async () => 'Your number is ' +
      (lo + Math.floor(Math.random() * (hi - lo + 1))) + ', Boss.';
  }

  m = raw.match(/^(?:take a note|make a note|add a note|note down|note:)\s*[:,-]?\s*(.+)/i);
  if (m) {
    return async () => {
      notes.push({ t: Date.now(), x: m[1] });
      notes = notes.slice(-100);
      store.set('jv_notes', notes);
      return 'Noted, Boss: ' + m[1];
    };
  }
  if (/^(show|read|list|my)( my)? notes$/.test(t)) {
    return async () => notes.length ?
      'Your notes, Boss:\n' + notes.map((n, i) => (i + 1) + '. ' + n.x).join('\n') :
      'You have no notes, Boss.';
  }
  if (/^(clear|delete)( all)?( my)? notes$/.test(t)) {
    return async () => {
      notes = [];
      store.set('jv_notes', notes);
      return 'All notes cleared, Boss.';
    };
  }

  return null;
}

async function handleTools(text) {
  const run = matchTool(text);
  return run ? await run() : null;
}

function showTool(out, res) {
  const r = typeof res === 'string' ? { text: res } : res;
  out.textContent = 'J.A.R.V.I.S: ' + r.text;
  const look = 'display:block;margin-top:6px;color:#000;background:#0ff;' +
    'padding:8px 10px;text-decoration:none;font-weight:bold;' +
    'text-align:center;border:0;width:100%;font-family:inherit;' +
    'font-size:12px;cursor:pointer';
  if (r.url) {
    const a = document.createElement('a');
    a.href = r.url;
    if (/^https?:/.test(r.url)) a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.label || 'OPEN';
    a.style.cssText = look;
    out.appendChild(a);
    if (r.auto) {
      try {
        if (/^intent:/.test(r.url)) location.href = r.url;
        else window.open(r.url, '_blank');
      } catch (e) {}
    }
  }
  if (r.img) {
    const im = new Image();
    im.src = r.img;
    im.style.cssText = 'display:block;max-width:100%;margin-top:8px;' +
      'border:1px solid #0ff';
    im.onerror = () => {
      const n = document.createElement('div');
      n.textContent = 'The image could not load. Try again, Boss.';
      out.appendChild(n);
    };
    out.appendChild(im);
  }
  if (r.file) {
    const a = document.createElement('a');
    a.href = r.file.url;
    a.download = r.file.name;
    a.textContent = r.file.label;
    a.style.cssText = look;
    out.appendChild(a);
  }
  if (r.click) {
    const b = document.createElement('button');
    b.textContent = r.label || 'OPEN';
    b.style.cssText = look;
    b.onclick = r.click;
    out.appendChild(b);
  }
  chat.scrollTop = chat.scrollHeight;
  return r.text;
}

async function send(text, img) {
  if (busy || !text) return;
  const tool = img ? null : matchTool(text);
  if (!tool && !apiKey && !askKey()) {
    add('J.A.R.V.I.S: API key required, Boss. ' +
      'Tap API KEY.', 'ai');
    return;
  }
  busy = true;
  lastAsk = text;
  localLearn(text);
  core.classList.add('busy');
  coreText.textContent = 'PROCESSING...';
  const u = add('YOU: ' + text, 'user');
  if (img) {
    const pic = new Image();
    pic.src = img;
    pic.className = 'shot';
    u.appendChild(pic);
  }
  input.value = '';
  const out = add('J.A.R.V.I.S: ...', 'ai');
  const parts = [{ text: text }];
  if (img) {
    parts.push({ inlineData: {
      mimeType: 'image/jpeg', data: img.split(',')[1]
    } });
  }
  const contents = history.concat([{ role: 'user', parts: parts }]);
  const show = t => {
    out.textContent = 'J.A.R.V.I.S: ' + stripMem(t);
    chat.scrollTop = chat.scrollHeight;
  };
  let err = '';
  const live = !img && needsLive(text);

  try {
    if (tool) {
      let res;
      try {
        res = await tool();
      } catch (e) {
        res = 'That tool failed, Boss: ' + e.message;
      }
      const reply = showTool(out, res);
      history = history.concat([
        { role: 'user', parts: [{ text: text }] },
        { role: 'model', parts: [{ text: reply }] }
      ]).slice(-40);
      store.set('jv_hist', history);
      saveChat();
      if (speak) say(reply);
      return;
    }
    let order = model ? [model] : [];
    const tried = {};
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        order = (await loadModels())
          .filter(m => !tried[m]);
      }
      for (const m of order) {
        tried[m] = 1;
        let r = await stream(m, contents, show, live);
        if (!r.ok && live && r.code === 400) {
          r = await stream(m, contents, show, false);
        }
        if (r.ok) {
          model = m;
          store.set('jv_model', m);
          const reply = stripMem(r.text);
          saveFacts(r.text);
          show(reply + srcLine(r.src));
          const mark = img ? ' [photo]' : '';
          history = history.concat([
            { role: 'user', parts: [{ text: text + mark }] },
            { role: 'model', parts: [{ text: reply }] }
          ]).slice(-40);
          store.set('jv_hist', history);
          saveChat();
          setRow('stAI', '● ONLINE', true);
          if (speak) say(reply);
          return;
        }
        err = r.msg;
        if ([400, 401, 403].includes(r.code)) {
          pass = 2;
          break;
        }
      }
    }
    out.textContent = 'J.A.R.V.I.S: ERROR - ' + err;
    setRow('stAI', '○ OFFLINE', false);
  } catch (e) {
    out.textContent = 'J.A.R.V.I.S: Cannot reach Google (' +
      e.message + '). Check internet, VPN, ad blocker.';
    setRow('stAI', '○ OFFLINE', false);
  } finally {
    busy = false;
    core.classList.remove('busy');
    coreText.textContent = 'CORE ACTIVE';
    refresh();
  }
}

$('send').onclick = () => send(input.value.trim());
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') send(input.value.trim());
});
$('keyBtn').onclick = askKey;
$('voiceBtn').onclick = () => {
  speak = !speak;
  store.set('jv_speak', speak);
  if (!speak && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
  refresh();
};
$('langBtn').onclick = () => {
  micLang = micLang === 'en-IN' ? 'te-IN' : 'en-IN';
  store.set('jv_lang', micLang);
  refresh();
};
$('clearBtn').onclick = () => {
  saveChat();
  history = [];
  openId = null;
  store.set('jv_hist', history);
  store.set('jv_open', openId);
  chat.innerHTML = '';
  refresh();
};

$('memBtn').onclick = () => {
  const p = $('memPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) showTab(tab);
};
$('tabFacts').onclick = () => showTab('facts');
$('tabChats').onclick = () => showTab('chats');
$('chatSearch').oninput = renderChats;
$('memWipe').onclick = () => {
  if (!confirm('Erase all long-term memory?')) return;
  facts = [];
  store.set('jv_facts', facts);
  renderMem();
  refresh();
};
$('cam').onclick = () => $('file').click();
$('file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const pic = await shrink(f, 1024);
    const q = input.value.trim() ||
      'What do you see? Describe it briefly.';
    send(q, pic);
  } catch (err) {
    add('J.A.R.V.I.S: Could not read that photo, Boss.', 'ai');
  }
};

const SR = window.SpeechRecognition ||
  window.webkitSpeechRecognition;
let micMode = SR ? 'sr' : 'rec';
let recording = null;

function micMsg(t) { add('J.A.R.V.I.S: ' + t, 'ai'); }
function micIcon(t) {
  $('mic').textContent = t;
  if (t === '🎤') {
    core.classList.remove('awake');
    if (!busy) coreText.textContent = 'CORE ACTIVE';
  }
}

const BLOCKED = 'Microphone is blocked, Boss. Tap the lock icon ' +
  'next to the web address, open Permissions, allow ' +
  'Microphone, then reload the page.';

function startMic(lang) {
  const r = new SR();
  let got = false, failed = false, started = false;
  r.lang = lang;
  r.onstart = () => { started = true; };
  r.interimResults = false;
  r.onresult = e => {
    got = true;
    send(e.results[0][0].transcript.trim());
  };
  r.onerror = e => {
    failed = true;
    const c = e.error;
    if (c === 'language-not-supported' && lang !== 'en-IN') {
      micMsg('This language is not supported for voice here. ' +
        'Using English.');
      startMic('en-IN');
      return;
    }
    micIcon('🎤');
    if (c === 'no-speech') {
      micMsg('I did not hear anything, Boss. Tap the mic ' +
        'and speak.');
    } else if (c !== 'aborted') {
      micMode = 'rec';
      recordVoice();
    }
  };
  r.onend = () => {
    if (failed) return;
    micIcon('🎤');
    if (!got) {
      micMode = 'rec';
      recordVoice();
    }
  };
  micIcon('…');
  try {
    r.start();
  } catch (err) {
    micIcon('🎤');
    micMode = 'rec';
    recordVoice();
    return;
  }
  setTimeout(() => {
    if (started || got || failed) return;
    failed = true;
    try { r.abort(); } catch (e) {}
    micMode = 'rec';
    micMsg('Voice typing did not respond. Using the backup microphone.');
    recordVoice();
  }, 7000);
}

function toWav(f32, rate) {
  const n = f32.length;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, t) => {
    for (let i = 0; i < t.length; i++) {
      v.setUint8(o + i, t.charCodeAt(i));
    }
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true);
  }
  return new Uint8Array(v.buffer);
}

function downsample(f32, from, to) {
  if (to >= from) return f32;
  const k = from / to;
  const out = new Float32Array(Math.floor(f32.length / k));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * k), b = Math.floor((i + 1) * k);
    let sum = 0;
    for (let j = a; j < b; j++) sum += f32[j];
    out[i] = sum / (b - a);
  }
  return out;
}

function toBase64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 8192) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  }
  return btoa(bin);
}

async function transcribe(b64) {
  const body = JSON.stringify({ contents: [{ parts: [
    { text: 'Transcribe this audio exactly as spoken, in the ' +
      'language spoken. Output only the transcript. If there ' +
      'is no speech, output NOSPEECH.' },
    { inlineData: { mimeType: 'audio/wav', data: b64 } }
  ] }] });
  const list = (model ? [model] : [])
    .concat(FALLBACK.filter(m => m !== model));
  let err = '';
  for (const m of list) {
    const res = await fetch(BASE + 'models/' + m +
      ':generateContent?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });
    const d = await res.json();
    if (res.ok) {
      const c = d.candidates && d.candidates[0];
      const p = c && c.content && c.content.parts;
      return p ? p.map(x => x.text || '').join('').trim() : '';
    }
    err = d.error ? d.error.message : 'HTTP ' + res.status;
    if ([400, 401, 403].includes(res.status)) break;
  }
  throw new Error(err);
}

async function recordVoice() {
  if (!apiKey && !askKey()) return;
  if (!navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia) {
    micMsg('This browser cannot use the microphone. ' +
      'Please open the site in Chrome (https link).');
    micIcon('🎤');
    return;
  }
  let media;
  try {
    media = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    micMsg(BLOCKED);
    micIcon('🎤');
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(media);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let heard = false, quiet = 0, done = false;
  const t0 = Date.now();

  const finish = async () => {
    if (done) return;
    done = true;
    recording = null;
    try { proc.disconnect(); src.disconnect(); } catch (e) {}
    media.getTracks().forEach(t => t.stop());
    const rate = ctx.sampleRate;
    try { ctx.close(); } catch (e) {}
    if (!heard) {
      micIcon('🎤');
      micMsg('I did not hear anything, Boss. Tap the mic ' +
        'and speak.');
      return;
    }
    micIcon('…');
    try {
      let len = 0;
      chunks.forEach(c => { len += c.length; });
      const all = new Float32Array(len);
      let pos = 0;
      chunks.forEach(c => { all.set(c, pos); pos += c.length; });
      const wav = toWav(downsample(all, rate, 16000),
        Math.min(rate, 16000));
      const text = await transcribe(toBase64(wav));
      micIcon('🎤');
      if (!text || text.indexOf('NOSPEECH') >= 0) {
        micMsg('I did not hear anything, Boss. Tap the mic ' +
          'and speak.');
      } else {
        send(text);
      }
    } catch (e) {
      micIcon('🎤');
      micMsg('Could not understand the audio: ' + e.message);
    }
  };

  proc.onaudioprocess = e => {
    const d = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(d));
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    if (Math.sqrt(sum / d.length) > 0.015) {
      heard = true;
      quiet = 0;
    } else if (heard) {
      quiet += d.length / ctx.sampleRate;
    }
    if (quiet > 1.3 || Date.now() - t0 > 15000) finish();
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  recording = { stop: finish };
  micIcon('🔴');
  micMsg('Listening, Boss. Speak now.');
}

$('mic').onclick = () => {
  if (recording) {
    recording.stop();
    return;
  }
  if (micMode === 'sr' && SR) startMic(micLang);
  else recordVoice();
};

window.addEventListener('online', refresh);
window.addEventListener('offline', refresh);

const WAKE_RE = /\b(?:hey|hi|ok|okay|hello|hai)[\s,]*(?:jarvis|jarvish|jarvas|jarvice|jarwis|javis|service)\b/i;
let wakeOn = false, wakeRec = null, wakeBusy = false, wakeFails = 0;
let wakeTimer = null;

function sayThen(t, cb) {
  if (!('speechSynthesis' in window)) { cb(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    speaking = false;
    setTimeout(cb, 250);
  };
  u.onstart = () => { speaking = true; };
  u.onend = u.onerror = go;
  setTimeout(go, 2500);
  speechSynthesis.speak(u);
}

function setWake(on) {
  wakeOn = on;
  const b = $('wake-btn');
  b.textContent = on ? 'WAKE: ON' : 'WAKE: OFF';
  b.classList.toggle('wake-on', on);
  if (!on) {
    clearTimeout(wakeTimer);
    try { if (wakeRec) wakeRec.abort(); } catch (e) {}
    wakeRec = null;
    wakeBusy = false;
  }
}

function wakeTrigger(rest) {
  wakeBusy = true;
  clearTimeout(wakeTimer);
  const r = wakeRec;
  wakeRec = null;
  try { if (r) r.abort(); } catch (e) {}
  core.classList.add('awake');
  coreText.textContent = 'LISTENING...';
  if (rest) {
    wakeBusy = false;
    core.classList.remove('awake');
    send(rest);
    return;
  }
  sayThen('Yes Boss?', () => {
    wakeBusy = false;
    startMic(micLang);
  });
}

function startWake() {
  const r = new SR();
  wakeRec = r;
  r.continuous = true;
  r.interimResults = true;
  r.lang = 'en-IN';
  r.onstart = () => { wakeFails = 0; };
  r.onresult = e => {
    if (speaking || wakeBusy) return;
    let said = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      said += e.results[i][0].transcript;
    }
    const m = said.match(WAKE_RE);
    if (!m) return;
    const rest = said.slice(m.index + m[0].length)
      .replace(/^[\s,.!?-]+/, '').trim();
    const final = e.results[e.results.length - 1].isFinal;
    clearTimeout(wakeTimer);
    if (rest && final) {
      wakeTrigger(rest);
    } else if (!rest) {
      wakeTimer = setTimeout(() => wakeTrigger(''), 1300);
    }
  };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setWake(false);
      micMsg(BLOCKED);
    } else if (e.error !== 'no-speech' && e.error !== 'aborted' &&
        ++wakeFails >= 4) {
      setWake(false);
      micMsg('Wake mode stopped: the voice service is not responding.');
    }
  };
  r.onend = () => { if (wakeRec === r) wakeRec = null; };
  try { r.start(); } catch (e) { wakeRec = null; }
}

function wakeTick() {
  if (!wakeOn || wakeRec || wakeBusy || busy || speaking) return;
  if (document.hidden || recording) return;
  if ($('mic').textContent !== '🎤') return;
  startWake();
}

$('wake-btn').onclick = () => {
  if (!SR) {
    micMsg('Wake mode needs voice typing, which this browser does ' +
      'not have. Please use Chrome.');
    return;
  }
  setWake(!wakeOn);
  if (wakeOn) {
    micMsg('Wake mode is ON. Say "Hey Jarvis" and then your command. ' +
      'Keep this screen open, and turn it off when you are done ' +
      'because it uses battery.');
  }
};
setInterval(wakeTick, 1500);

renderHistory();
if (history.length && !openId) saveChat();
tabLabels();
timers.forEach(armTimer);
if (apiKey) setRow('stAI', '● READY', true);
refresh();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.JV_OK = true;
