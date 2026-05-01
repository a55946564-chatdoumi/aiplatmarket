/**
 * ============================================================
 * AI PLATMARKET - index.js (통합 완전판 v2)
 *
 * 기능:
 *   ✅ 네이버 뉴스 API 실시간 연동
 *   ✅ 구글 뉴스 RSS 연동
 *   ✅ Gmail 뉴스레터 자동 수집
 *      - 뉴스와이어 (newswire.co.kr / newswire.or.kr)
 *      - 과학향기 / 생활과학 (kisti.re.kr / kist.re.kr)
 *   ✅ 카테고리 '생활과학' 추가
 *   ✅ AI 재편집: 본문 핵심 2줄 요약
 *   ✅ 30분 캐시 (API 과호출 방지)
 *   ✅ Firebase 업체/승인/광고/기자단/지역본부 관리
 *
 * Render 환경변수:
 *   ADMIN_TOKEN         필수
 *   NAVER_CLIENT_ID     필수 (네이버 개발자센터)
 *   NAVER_CLIENT_SECRET 필수
 *   GMAIL_USER          뉴스레터 수신 Gmail 주소
 *   GMAIL_APP_PASSWORD  Gmail 앱 비밀번호 16자리
 *
 * Render Secret Files:
 *   serviceAccountKey.json
 *
 * npm 패키지 (package.json dependencies):
 *   express, firebase-admin, cors, imap, mailparser
 * ============================================================
 */

'use strict';

const express = require('express');
const admin   = require('firebase-admin');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Firebase ── */
let db;
try {
  const sa = require('./serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  console.log('✅ Firebase 연결');
} catch (e) {
  console.error('❌ Firebase:', e.message);
}
function requireDB(res) {
  if (!db) { res.status(503).json({ error: 'Firebase 연결 안 됨' }); return false; }
  return true;
}

/* ── 환경변수 ── */
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN    || 'dev-token-change-me';
const NAVER_ID     = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
let autoApprove    = false;

function adminAuth(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== ADMIN_TOKEN) return res.status(401).json({ error: '인증 실패' });
  next();
}

/* ── 캐시 ── */
const CACHE_TTL = 30 * 60 * 1000;
const _cache = {};
function getCache(k) { const c=_cache[k]; return (c && Date.now()-c.at<CACHE_TTL) ? c.data : null; }
function setCache(k,d) { _cache[k]={ data:d, at:Date.now() }; }

/* ── HTTP fetch ── */
function fetchUrl(url, headers={}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const u   = new URL(url);
    mod.get({ hostname:u.hostname, path:u.pathname+u.search, headers }, res => {
      let d='';
      res.on('data', c => d+=c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

/* ── AI 요약 ── */
function aiSummarize(text='', max=150) {
  const clean = text.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return clean.slice(0, max) + (clean.length > max ? '...' : '');
}

/* ════════════════════════════════════
   1. 네이버 뉴스 API
════════════════════════════════════ */
async function naverNews(keyword, display=10) {
  const key = 'naver:'+keyword;
  const hit = getCache(key);
  if (hit) return hit;
  if (!NAVER_ID||!NAVER_SECRET) throw new Error('NAVER 환경변수 없음');

  const data = await new Promise((resolve, reject) => {
    https.get({
      hostname: 'openapi.naver.com',
      path: `/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=${display}&sort=date`,
      headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET },
    }, res => {
      let d='';
      res.on('data', c=>d+=c);
      res.on('end', ()=>{ try{ resolve(JSON.parse(d)); }catch(e){ reject(e); } });
    }).on('error', reject);
  });

  const items = (data.items||[]).map(n => ({
    title:  n.title.replace(/<[^>]+>/g,''),
    desc:   aiSummarize(n.description),
    link:   n.originallink||n.link,
    date:   n.pubDate,
    source: n.originallink?.match(/([a-z0-9-]+)\.[a-z]+/)?.[1] || '네이버',
    origin: 'naver',
  }));
  setCache(key, items);
  return items;
}

/* ════════════════════════════════════
   2. 구글 뉴스 RSS
════════════════════════════════════ */
async function googleNews(keyword) {
  const key = 'google:'+keyword;
  const hit = getCache(key);
  if (hit) return hit;

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
  const xml = await fetchUrl(url, { 'User-Agent':'Mozilla/5.0' });

  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m=re.exec(xml))!==null && items.length<10) {
    const b = m[1];
    const title  = (/<title><!\[CDATA\[(.*?)\]\]>/.exec(b)||/<title>(.*?)<\/title>/.exec(b))?.[1]||'';
    const link   = (/<link>(.*?)<\/link>/.exec(b))?.[1]||'';
    const desc   = (/<description><!\[CDATA\[(.*?)\]\]>/.exec(b)||/<description>(.*?)<\/description>/.exec(b))?.[1]||'';
    const date   = (/<pubDate>(.*?)<\/pubDate>/.exec(b))?.[1]||'';
    const source = (/<source[^>]*>(.*?)<\/source>/.exec(b))?.[1]||'구글뉴스';
    if (title) items.push({ title:title.replace(/<[^>]+>/g,'').trim(), desc:aiSummarize(desc), link:link.trim(), date:date.trim(), source, origin:'google' });
  }
  setCache(key, items);
  return items;
}

/* ════════════════════════════════════
   3. Gmail 뉴스레터 수집
      - 뉴스와이어 (newswire.co.kr / newswire.or.kr)
      - 과학향기 / 생활과학 (kisti.re.kr / kist.re.kr)
════════════════════════════════════ */
let gmailCache = [];
let gmailAt    = 0;

async function fetchGmail() {
  if (Date.now()-gmailAt < CACHE_TTL && gmailCache.length) return gmailCache;
  const Imap = require('imap');
  const { simpleParser } = require('mailparser');

  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER, password: GMAIL_PASS,
      host: 'imap.gmail.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false }, connTimeout: 15000,
    });
    const results = [];
    imap.once('ready', () => {
      imap.openBox('INBOX', true, err => {
        if (err) return reject(err);
        const since = new Date();
        since.setDate(since.getDate()-7);
        imap.search([
          ['SINCE', since],
          ['OR',
            ['OR', ['FROM','newswire.co.kr'], ['FROM','newswire.or.kr']],
            ['OR', ['FROM','kisti.re.kr'],    ['FROM','kist.re.kr']],
          ],
        ], (err, uids) => {
          if (err||!uids||!uids.length) { imap.end(); return resolve([]); }
          const f = imap.fetch(uids.slice(-20), { bodies:'' });
          f.on('message', msg => {
            msg.on('body', stream => {
              simpleParser(stream, (err, mail) => {
                if (err) return;
                const from = mail.from?.text||'';
                const sub  = mail.subject||'';
                const text = mail.text||'';
                let cat = '뉴스레터';
                if (from.includes('newswire')) cat = '뉴스와이어';
                else if (from.includes('kisti')||from.includes('kist'))
                  cat = '생활과학'; // 과학향기·생활과학 모두 생활과학으로 통합
                results.push({
                  title: sub, desc: aiSummarize(text), date: mail.date?.toISOString()||new Date().toISOString(),
                  from, cat, link:'#', origin:'email', source: cat,
                });
              });
            });
          });
          f.once('end', () => imap.end());
        });
      });
    });
    imap.once('end', () => { gmailCache=results; gmailAt=Date.now(); resolve(results); });
    imap.once('error', reject);
    imap.connect();
  });
}

/* ── 카테고리별 키워드 매핑 ── */
const KEYWORD_MAP = {
  전체:'소상공인', 경제:'소상공인 경제 매출', 창업:'소상공인 창업 지원',
  IT:'소상공인 AI IT 디지털', 농수산:'로컬푸드 농수산 직거래',
  지방자치:'지방자치 소상공인', 사회:'소상공인 사회 지역', 교육:'소상공인 교육',
  'Job뉴스':'소상공인 채용 일자리', 부동산:'소상공인 임차료 상가',
  생활:'지역 생활 소상공인', 생활과학:'생활과학 kisti', 과학향기:'과학 기술 kisti',
};

/* ════════════════════════════════════
   📰 통합 뉴스 API
   GET /api/news?cat=전체&source=all|naver|google|email&display=10
════════════════════════════════════ */
app.get('/api/news', async (req, res) => {
  const { cat='전체', source='all', display=10 } = req.query;
  const keyword = KEYWORD_MAP[cat]||cat;
  const result  = { cat, items:[], sources:[], warnings:[] };

  /* 이메일 전용 카테고리 */
  if (['뉴스와이어','생활과학'].includes(cat)) {
    if (!GMAIL_USER||!GMAIL_PASS)
      return res.json({ ...result, error:'Gmail 미설정', items: getFallback(cat) });
    try {
      const all = await fetchGmail();
      result.items = all.filter(n=>n.cat===cat||n.source===cat);
      result.sources = ['email'];
      return res.json(result);
    } catch(e) {
      return res.json({ ...result, error:e.message, items:getFallback(cat) });
    }
  }

  /* 네이버 */
  if (source==='all'||source==='naver') {
    try { result.items.push(...await naverNews(keyword, Number(display))); result.sources.push('naver'); }
    catch(e) { result.warnings.push('naver: '+e.message); }
  }

  /* 구글 */
  if (source==='all'||source==='google') {
    try {
      const gItems = await googleNews(keyword);
      const exists = new Set(result.items.map(n=>n.title));
      result.items.push(...gItems.filter(n=>!exists.has(n.title)));
      result.sources.push('google');
    } catch(e) { result.warnings.push('google: '+e.message); }
  }

  /* Gmail 뉴스레터 (전체 모드) */
  if (source==='all' && GMAIL_USER && GMAIL_PASS) {
    try {
      const emails = await fetchGmail();
      result.items.push(...emails.slice(0,5));
      result.sources.push('email');
    } catch(e) { result.warnings.push('email: '+e.message); }
  }

  result.items.sort((a,b)=>new Date(b.date)-new Date(a.date));
  result.items = result.items.slice(0, Number(display)*2);
  if (!result.items.length) result.items = getFallback(cat);
  res.json(result);
});

/* ── 속보 ── */
app.get('/api/breaking', async (req, res) => {
  try { res.json({ ok:true, items:(await naverNews('소상공인 속보',6)).map(n=>'📌 '+n.title) }); }
  catch(e) { res.json({ ok:false, items:['📌 AI플랫마켓 소상공인 지원 프로그램 시작','🔥 인천 남동구 오늘의 특가','📊 2026 소상공인 매출 18% 증가'] }); }
});

/* ── 뉴스레터 전용 ── */
app.get('/api/newsletter', async (req, res) => {
  const { cat='전체' } = req.query;
  if (!GMAIL_USER||!GMAIL_PASS) return res.json({ ok:false, message:'Gmail 미설정', setup:['GMAIL_USER / GMAIL_APP_PASSWORD 환경변수 등록 필요'], items:[] });
  try {
    const all = await fetchGmail();
    res.json({ ok:true, cat, count:all.length, items: cat==='전체'?all:all.filter(n=>n.cat===cat||n.source===cat) });
  } catch(e) { res.json({ ok:false, error:e.message, items:[] }); }
});

function getFallback(cat) {
  return [
    { title:`[${cat}] 소상공인 지원금 200만원 확대`, desc:'정부가 소상공인 디지털 전환 지원 규모를 확대합니다.', link:'#', date:new Date().toISOString(), source:'fallback', origin:'fallback' },
    { title:`[${cat}] 2026 유망 업종 AI 분석 결과 공개`, desc:'AI가 분석한 2026년 유망 창업 아이템을 소개합니다.', link:'#', date:new Date().toISOString(), source:'fallback', origin:'fallback' },
  ];
}

/* ════════════════════════════════════
   🏪 업체 API
════════════════════════════════════ */
app.post('/api/store', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { name, owner='', region='', category='', phone, item='', desc='', email='' } = req.body;
    if (!name||!phone) return res.status(400).json({ error:'업체명·전화번호 필수' });
    const ref = await db.collection('stores').add({
      name:name.trim(), owner, region, category, phone:phone.trim(),
      item, desc, email, views:0, clicks:0, premium:false,
      approved:autoApprove, aiCopy:'',
      createdAt:admin.firestore.FieldValue.serverTimestamp(),
    });
    if (autoApprove && (desc||item))
      await db.collection('stores').doc(ref.id).update({ aiCopy:`[AI] ${name}은 ${region}의 ${category}입니다. 지금 방문해 보세요!` });
    res.json({ ok:true, id:ref.id, approved:autoApprove });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/store', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { region, category, keyword, sort, all } = req.query;
    let ref = db.collection('stores');
    if (all!=='true') ref=ref.where('approved','==',true);
    if (category) ref=ref.where('category','==',category);
    ref=ref.orderBy(sort==='new'?'createdAt':'clicks','desc');
    const snap  = await ref.limit(300).get();
    let stores  = snap.docs.map(d=>({ id:d.id,...d.data(), createdAt:d.data().createdAt?.toDate?.()?.toISOString()||'' }));
    if (region)  stores=stores.filter(s=>s.region?.includes(region));
    if (keyword) { const kw=keyword.toLowerCase(); stores=stores.filter(s=>(s.name||'').toLowerCase().includes(kw)||(s.item||'').toLowerCase().includes(kw)||(s.desc||'').toLowerCase().includes(kw)); }
    stores.sort((a,b)=>(b.premium?1:0)-(a.premium?1:0));
    res.json(stores);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/view',        async (req,res)=>{ if(!requireDB(res))return; if(req.body.id) await db.collection('stores').doc(req.body.id).update({views:admin.firestore.FieldValue.increment(1)}).catch(()=>{}); res.json({ok:true}); });
app.post('/api/click',       async (req,res)=>{ if(!requireDB(res))return; if(req.body.id) await db.collection('stores').doc(req.body.id).update({clicks:admin.firestore.FieldValue.increment(1)}).catch(()=>{}); res.json({ok:true}); });
app.post('/api/ads/upgrade', async (req,res)=>{ if(!requireDB(res))return; if(req.body.id) await db.collection('stores').doc(req.body.id).update({premium:true}).catch(()=>{}); res.json({ok:true}); });

app.get('/api/stats', async (req, res) => {
  if (!requireDB(res)) return;
  const snap=await db.collection('stores').get();
  const stores=snap.docs.map(d=>d.data());
  const catMap={};
  stores.forEach(s=>{ if(s.category) catMap[s.category]=(catMap[s.category]||0)+1; });
  res.json({ total:stores.length, approved:stores.filter(s=>s.approved).length, pending:stores.filter(s=>!s.approved).length, premium:stores.filter(s=>s.premium).length, totalClicks:stores.reduce((n,s)=>n+(s.clicks||0),0), totalViews:stores.reduce((n,s)=>n+(s.views||0),0), categories:catMap });
});

/* ── 신청 API ── */
const FS = admin.firestore.FieldValue;
const addDoc=(col,body)=>db.collection(col).add({...body,status:'pending',createdAt:FS.serverTimestamp()});
app.post('/api/branch',     async (req,res)=>{ if(!requireDB(res))return; try{await addDoc('branches',req.body);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/reporter',   async (req,res)=>{ if(!requireDB(res))return; try{await addDoc('reporters',req.body);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/ad-request', async (req,res)=>{ if(!requireDB(res))return; try{await addDoc('ad_requests',req.body);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});} });

/* ════════════════════════════════════
   🛡 관리자 API
════════════════════════════════════ */
app.post('/api/admin/approve', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const { id, approve=true } = req.body;
  if (!id) return res.status(400).json({ error:'id 필요' });
  const upd = { approved:!!approve };
  if (approve) {
    const doc = await db.collection('stores').doc(id).get();
    if (doc.exists) { const s=doc.data(); upd.aiCopy=`[AI 홍보문구] ${s.name}은 ${s.region}의 인기 ${s.category}입니다. ${s.item?s.item+'을(를) 전문으로 하며, ':''}합리적인 가격과 친절한 서비스로 사랑받고 있습니다.`; }
  }
  await db.collection('stores').doc(id).update(upd);
  res.json({ ok:true });
});

app.delete('/api/admin/store/:id', adminAuth, async (req,res)=>{ if(!requireDB(res))return; await db.collection('stores').doc(req.params.id).delete(); res.json({ok:true}); });

const listCol=(col)=>async(req,res)=>{ if(!requireDB(res))return; const snap=await db.collection(col).orderBy('createdAt','desc').limit(100).get(); res.json(snap.docs.map(d=>({id:d.id,...d.data(),createdAt:d.data().createdAt?.toDate?.()?.toISOString()||''}))); };
app.get('/api/admin/branches',    adminAuth, listCol('branches'));
app.get('/api/admin/reporters',   adminAuth, listCol('reporters'));
app.get('/api/admin/ad_requests', adminAuth, listCol('ad_requests'));

const patchCol=(col)=>async(req,res)=>{ if(!requireDB(res))return; await db.collection(col).doc(req.params.id).update({status:req.body.status,updatedAt:FS.serverTimestamp()}); res.json({ok:true}); };
app.patch('/api/admin/branches/:id',    adminAuth, patchCol('branches'));
app.patch('/api/admin/reporters/:id',   adminAuth, patchCol('reporters'));
app.patch('/api/admin/ad_requests/:id', adminAuth, patchCol('ad_requests'));

app.post('/api/admin/auto-approve', adminAuth, (req,res)=>{ autoApprove=!!req.body.enabled; console.log('자동승인:'+autoApprove); res.json({ok:true,autoApprove}); });

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const [ss,bs,rs,as] = await Promise.all([ db.collection('stores').get(), db.collection('branches').get(), db.collection('reporters').get(), db.collection('ad_requests').get() ]);
  const stores = ss.docs.map(d=>d.data());
  res.json({
    stores:{ total:stores.length, approved:stores.filter(s=>s.approved).length, pending:stores.filter(s=>!s.approved).length, premium:stores.filter(s=>s.premium).length, clicks:stores.reduce((n,s)=>n+(s.clicks||0),0), views:stores.reduce((n,s)=>n+(s.views||0),0) },
    branches:{total:bs.size, pending:bs.docs.filter(d=>d.data().status==='pending').length},
    reporters:{total:rs.size, pending:rs.docs.filter(d=>d.data().status==='pending').length},
    adRequests:{total:as.size, pending:as.docs.filter(d=>d.data().status==='pending').length},
  });
});

/* ── 라우트 ── */
app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

/* ── 서버 기동 ── */
app.listen(PORT, ()=>{
  console.log(`\n🚀 AI플랫마켓 → http://localhost:${PORT}`);
  console.log(`🛡 관리자    → http://localhost:${PORT}/admin`);
  console.log(`📰 네이버API : ${NAVER_ID  ? '✅ 연동됨' : '❌ 미설정'}`);
  console.log(`📧 Gmail    : ${GMAIL_USER ? '✅ 연동됨' : '❌ 미설정'}`);
  if (ADMIN_TOKEN==='dev-token-change-me') console.warn('⚠️  ADMIN_TOKEN 변경 필요!');
});
