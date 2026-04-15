/**
 * ============================================================
 * AI PLATMARKET - Render 배포 서버 (완전판)
 * Firebase Admin SDK + Firestore 연동
 * ============================================================
 *
 * 디렉토리 구조:
 * ├ server.js
 * ├ serviceAccountKey.json  (Render Secret Files에 등록)
 * └ public/
 *     ├ index.html          (메인 사이트)
 *     └ admin.html          (관리자 대시보드)
 *
 * Render 환경변수:
 *   ADMIN_TOKEN = 임의의 비밀 토큰 (관리자 API 보호용)
 *                예: openssl rand -hex 32 로 생성
 * ============================================================
 */

const express = require('express');
const admin   = require('firebase-admin');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── 미들웨어 ── */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ──────────────────────────────────────────
   🔥 Firebase 초기화 (Render Secret File 방식)
   Render > Environment > Secret Files 에서
   파일명: serviceAccountKey.json 로 등록
────────────────────────────────────────── */
let db;
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase 연결 성공');
} catch (err) {
  console.error('❌ Firebase 초기화 실패:', err.message);
  console.log('💡 Render > Environment > Secret Files 에 serviceAccountKey.json 등록 필요');
}

/* ── DB 없을 때 에러 방지 ── */
function requireDB(res) {
  if (!db) { res.status(503).json({ error: 'Firebase 연결 안 됨' }); return false; }
  return true;
}

/* ── 관리자 토큰 인증 미들웨어 ── */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-change-me';
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: '관리자 인증 실패' });
  }
  next();
}

/* ── 자동 승인 설정 (서버 메모리, 실제 운영 시 Firestore 저장 권장) ── */
let autoApprove = false;

/* =============================================================
   📌 공개 API
============================================================= */

/* 업체 등록 */
app.post('/api/store', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { name, owner, region, category, phone, item, desc, email } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '업체명과 전화번호는 필수입니다.' });

    const docRef = await db.collection('stores').add({
      name:      name.trim(),
      owner:     owner    || '',
      region:    region   || '',
      category:  category || '',
      phone:     phone.trim(),
      item:      item     || '',
      desc:      desc     || '',
      email:     email    || '',
      views:     0,
      clicks:    0,
      premium:   false,
      approved:  autoApprove, // 자동승인 ON이면 즉시 노출
      aiCopy:    '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 자동 승인 + AI 홍보문구 자동 생성 (간단 버전)
    if (autoApprove && desc) {
      const aiCopy = `[AI] ${name}은 ${region}의 ${category}로, ${item||'다양한 서비스'}를 제공합니다. 지금 바로 방문해 보세요!`;
      await db.collection('stores').doc(docRef.id).update({ aiCopy });
    }

    res.json({ success: true, id: docRef.id, approved: autoApprove });
  } catch (err) {
    console.error('[POST /api/store]', err);
    res.status(500).json({ error: '등록 중 오류 발생' });
  }
});

/* 업체 목록 조회 (승인된 업체만 공개 — all=true 파라미터 시 전체) */
app.get('/api/store', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { region, category, keyword, sort, all } = req.query;

    let ref = db.collection('stores');

    // 공개 API: all=true가 아니면 승인된 업체만
    if (all !== 'true') ref = ref.where('approved', '==', true);
    if (category) ref = ref.where('category', '==', category);

    const sortField = sort === 'new' ? 'createdAt' : 'clicks';
    ref = ref.orderBy(sortField, 'desc');

    const snapshot = await ref.limit(300).get();
    let stores = snapshot.docs.map(doc => ({
      id:        doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || '',
    }));

    if (region)  stores = stores.filter(s => s.region  && s.region.includes(region));
    if (keyword) {
      const kw = keyword.toLowerCase();
      stores = stores.filter(s =>
        (s.name ||'').toLowerCase().includes(kw) ||
        (s.item ||'').toLowerCase().includes(kw) ||
        (s.desc ||'').toLowerCase().includes(kw)
      );
    }

    // 프리미엄 상단 고정
    stores.sort((a, b) => {
      if (a.premium && !b.premium) return -1;
      if (!a.premium && b.premium)  return  1;
      return 0;
    });

    res.json(stores);
  } catch (err) {
    console.error('[GET /api/store]', err);
    res.status(500).json({ error: '목록 조회 오류' });
  }
});

/* 조회수 증가 */
app.post('/api/view', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id 필요' });
    await db.collection('stores').doc(id).update({
      views: admin.firestore.FieldValue.increment(1),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '조회수 업데이트 오류' });
  }
});

/* 클릭 추적 */
app.post('/api/click', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id 필요' });
    await db.collection('stores').doc(id).update({
      clicks: admin.firestore.FieldValue.increment(1),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '클릭 업데이트 오류' });
  }
});

/* 프리미엄 업그레이드 */
app.post('/api/ads/upgrade', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id, name } = req.body;
    if (id) {
      await db.collection('stores').doc(id).update({ premium: true });
      return res.json({ success: true });
    }
    if (name) {
      const snapshot = await db.collection('stores').where('name', '==', name).get();
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.update(doc.ref, { premium: true }));
      await batch.commit();
      return res.json({ success: true, updated: snapshot.size });
    }
    res.status(400).json({ error: 'id 또는 name 필요' });
  } catch (err) {
    res.status(500).json({ error: '업그레이드 오류' });
  }
});

/* AI 매출 추천 */
app.get('/api/ai-recommend', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id 필요' });
    const doc = await db.collection('stores').doc(id).get();
    if (!doc.exists) return res.status(404).json({ result: '데이터 없음' });
    const { clicks=0, views=0, premium } = doc.data();
    let result, level;
    if      (clicks > 100) { result = '🔥 매우 활성화! 프리미엄 광고 전환 시 매출 2배 기대'; level = 'hot'; }
    else if (clicks >  30) { result = '📈 관심도 높음 → 이벤트 또는 라이브 방송 참여 추천';    level = 'warm'; }
    else if (views  > 100) { result = '👀 노출 多 클릭 少 → 소개 문구 개선 권장';              level = 'mid'; }
    else                   { result = '📢 노출 부족 → 광고 등록 또는 카테고리 재설정 권장';    level = 'low'; }
    res.json({ result, level, clicks, views, premium });
  } catch (err) {
    res.status(500).json({ error: '추천 분석 오류' });
  }
});

/* 통계 */
app.get('/api/stats', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const snapshot = await db.collection('stores').get();
    const stores   = snapshot.docs.map(d => d.data());
    const catMap   = {};
    stores.forEach(s => { if (s.category) catMap[s.category] = (catMap[s.category] || 0) + 1; });
    res.json({
      total:        stores.length,
      approved:     stores.filter(s => s.approved).length,
      pending:      stores.filter(s => !s.approved).length,
      premium:      stores.filter(s => s.premium).length,
      totalClicks:  stores.reduce((sum, s) => sum + (s.clicks || 0), 0),
      totalViews:   stores.reduce((sum, s) => sum + (s.views  || 0), 0),
      categories:   catMap,
    });
  } catch (err) {
    res.status(500).json({ error: '통계 조회 오류' });
  }
});

/* 지역본부/지사 신청 */
app.post('/api/branch', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { name, phone, email, type, region, desc } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '성명과 연락처는 필수입니다.' });
    await db.collection('branches').add({
      name, phone, email: email||'', type: type||'', region: region||'', desc: desc||'',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/branch]', err);
    res.status(500).json({ error: '신청 등록 오류' });
  }
});

/* 홍보기자단 신청 */
app.post('/api/reporter', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { name, phone, email, grade, region, intro } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '성명과 연락처는 필수입니다.' });
    await db.collection('reporters').add({
      name, phone, email: email||'', grade: grade||'', region: region||'', intro: intro||'',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/reporter]', err);
    res.status(500).json({ error: '신청 등록 오류' });
  }
});

/* 광고 신청 */
app.post('/api/ad-request', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { biz, phone, type, budget, content } = req.body;
    if (!biz || !phone) return res.status(400).json({ error: '업체명과 연락처는 필수입니다.' });
    await db.collection('ad_requests').add({
      biz, phone, type: type||'', budget: budget||'', content: content||'',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '광고 신청 오류' });
  }
});

/* =============================================================
   🛡 관리자 전용 API  (adminAuth 미들웨어 적용)
   헤더: X-Admin-Token: <ADMIN_TOKEN>
============================================================= */

/* 입점 승인/거절 */
app.post('/api/admin/approve', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id, approve = true } = req.body;
    if (!id) return res.status(400).json({ error: 'id 필요' });
    const updateData = { approved: !!approve };

    // AI 홍보문구 자동 생성 (승인 시)
    if (approve) {
      const doc = await db.collection('stores').doc(id).get();
      if (doc.exists) {
        const s = doc.data();
        const aiCopy = `[AI 홍보문구] ${s.name}은 ${s.region}의 인기 ${s.category}입니다. ${s.item ? s.item + '을(를) 전문으로 하며, ' : ''}합리적인 가격과 친절한 서비스로 지역 주민에게 사랑받고 있습니다.`;
        updateData.aiCopy = aiCopy;
      }
    }

    await db.collection('stores').doc(id).update(updateData);
    res.json({ success: true, approved: !!approve });
  } catch (err) {
    console.error('[POST /api/admin/approve]', err);
    res.status(500).json({ error: '승인 처리 오류' });
  }
});

/* 업체 삭제 */
app.delete('/api/admin/store/:id', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    await db.collection('stores').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '삭제 오류' });
  }
});

/* 지역본부/지사 목록 조회 */
app.get('/api/admin/branches', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const snap = await db.collection('branches').orderBy('createdAt', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString()||'' })));
  } catch (err) {
    res.status(500).json({ error: '조회 오류' });
  }
});

/* 지역본부/지사 상태 변경 */
app.patch('/api/admin/branches/:id', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { status } = req.body;
    await db.collection('branches').doc(req.params.id).update({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '상태 변경 오류' });
  }
});

/* 홍보기자단 목록 조회 */
app.get('/api/admin/reporters', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const snap = await db.collection('reporters').orderBy('createdAt', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString()||'' })));
  } catch (err) {
    res.status(500).json({ error: '조회 오류' });
  }
});

/* 홍보기자단 상태 변경 */
app.patch('/api/admin/reporters/:id', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { status } = req.body;
    await db.collection('reporters').doc(req.params.id).update({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '상태 변경 오류' });
  }
});

/* 광고 신청 목록 조회 */
app.get('/api/admin/ad_requests', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const snap = await db.collection('ad_requests').orderBy('createdAt', 'desc').limit(100).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString()||'' })));
  } catch (err) {
    res.status(500).json({ error: '조회 오류' });
  }
});

/* 광고 신청 상태 변경 */
app.patch('/api/admin/ad_requests/:id', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { status } = req.body;
    await db.collection('ad_requests').doc(req.params.id).update({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '상태 변경 오류' });
  }
});

/* 자동 승인 설정 변경 */
app.post('/api/admin/auto-approve', adminAuth, (req, res) => {
  autoApprove = !!req.body.enabled;
  console.log(`자동 승인: ${autoApprove ? 'ON' : 'OFF'}`);
  res.json({ success: true, autoApprove });
});

/* 전체 대시보드 통계 (관리자용) */
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const [storeSnap, branchSnap, reporterSnap, adReqSnap] = await Promise.all([
      db.collection('stores').get(),
      db.collection('branches').get(),
      db.collection('reporters').get(),
      db.collection('ad_requests').get(),
    ]);
    const stores = storeSnap.docs.map(d => d.data());
    res.json({
      stores: {
        total:    stores.length,
        approved: stores.filter(s => s.approved).length,
        pending:  stores.filter(s => !s.approved).length,
        premium:  stores.filter(s => s.premium).length,
        clicks:   stores.reduce((s, x) => s + (x.clicks||0), 0),
        views:    stores.reduce((s, x) => s + (x.views||0), 0),
      },
      branches:  { total: branchSnap.size,    pending: branchSnap.docs.filter(d=>d.data().status==='pending').length },
      reporters: { total: reporterSnap.size,  pending: reporterSnap.docs.filter(d=>d.data().status==='pending').length },
      adRequests:{ total: adReqSnap.size,     pending: adReqSnap.docs.filter(d=>d.data().status==='pending').length },
    });
  } catch (err) {
    res.status(500).json({ error: '통계 조회 오류' });
  }
});

/* =============================================================
   관리자 페이지 라우트
============================================================= */
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* SPA 폴백 */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── 서버 기동 ── */
app.listen(PORT, () => {
  console.log(`🚀 AI플랫마켓 서버 실행 → http://localhost:${PORT}`);
  console.log(`🛡 관리자 페이지 → http://localhost:${PORT}/admin`);
  if (ADMIN_TOKEN === 'dev-admin-token-change-me') {
    console.warn('⚠️  ADMIN_TOKEN이 기본값입니다. Render 환경변수에서 반드시 변경하세요!');
  }
});