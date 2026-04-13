/**
 * ============================================================
 * AI PLATMARKET - 렌더(Render) 배포 서버
 * Firebase Admin SDK + Firestore 연동
 * ============================================================
 */

const express  = require('express');
const admin    = require('firebase-admin');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── 미들웨어 ── */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ──────────────────────────────────────────
   🔥 Firebase 초기화 (Secret File 방식)
   Render의 'Secret Files' 설정에서 
   serviceAccountKey.json 파일을 생성했다면 아래 코드가 작동합니다.
────────────────────────────────────────── */
let db;
try {
  // 1. 먼저 Secret File로 생성된 파일을 불러옵니다.
  const serviceAccount = require('./serviceAccountKey.json');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  
  db = admin.firestore();
  console.log('✅ Firebase 연결 성공 (Secret File 사용)');
} catch (err) {
  console.error('❌ Firebase 초기화 실패:', err.message);
  console.log('💡 힌트: Render의 Environment > Secret Files에 serviceAccountKey.json이 있는지 확인하세요.');
}

/* ──────────────────────────────────────────
   헬퍼: Firestore 없을 때 에러 방지
────────────────────────────────────────── */
function requireDB(res) {
  if (!db) {
    res.status(503).json({ error: 'Firebase 연결 안 됨' });
    return false;
  }
  return true;
}

/* ============================================================
   📌 업체 등록  POST /api/store
============================================================ */
app.post('/api/store', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const {
      name, owner, region, category, phone, item, desc, email
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: '업체명과 전화번호는 필수입니다.' });
    }

    const docRef = await db.collection('stores').add({
      name:      name.trim(),
      owner:     owner   || '',
      region:    region  || '',
      category:  category|| '',
      phone:     phone.trim(),
      item:      item    || '',
      desc:      desc    || '',
      email:     email   || '',
      views:     0,
      clicks:    0,
      premium:   false,
      approved:  false,   // 심사 후 true 로 변경
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error('[POST /api/store]', err);
    res.status(500).json({ error: '등록 중 오류 발생' });
  }
});

/* ============================================================
   📋 업체 목록  GET /api/store
   쿼리: ?region=인천&category=음식점&keyword=삼겹&sort=clicks
============================================================ */
app.get('/api/store', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { region, category, keyword, sort } = req.query;

    let ref = db.collection('stores');

    // 카테고리 필터 (Firestore where)
    if (category) ref = ref.where('category', '==', category);

    // 정렬
    const sortField = sort === 'new' ? 'createdAt' : 'clicks';
    ref = ref.orderBy(sortField, 'desc');

    const snapshot = await ref.limit(200).get();
    let stores = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || '',
    }));

    // 지역 필터 (JS 측)
    if (region) stores = stores.filter(s => s.region && s.region.includes(region));

    // 키워드 필터 (JS 측)
    if (keyword) {
      const kw = keyword.toLowerCase();
      stores = stores.filter(s =>
        (s.name  && s.name.toLowerCase().includes(kw)) ||
        (s.item  && s.item.toLowerCase().includes(kw)) ||
        (s.desc  && s.desc.toLowerCase().includes(kw))
      );
    }

    // 프리미엄 업체 상단 고정
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

/* ============================================================
   👁 조회수 증가  POST /api/view
============================================================ */
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
    console.error('[POST /api/view]', err);
    res.status(500).json({ error: '조회수 업데이트 오류' });
  }
});

/* ============================================================
   🖱 클릭 추적  POST /api/click
============================================================ */
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
    console.error('[POST /api/click]', err);
    res.status(500).json({ error: '클릭 업데이트 오류' });
  }
});

/* ============================================================
   ⭐ 광고 업그레이드  POST /api/ads/upgrade
   body: { id: '...' } 또는 { name: '업체명' }
============================================================ */
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
    console.error('[POST /api/ads/upgrade]', err);
    res.status(500).json({ error: '업그레이드 오류' });
  }
});

/* ============================================================
   🤖 AI 매출 추천  GET /api/ai-recommend?id=...
============================================================ */
app.get('/api/ai-recommend', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id, name } = req.query;
    let storeData = null;

    if (id) {
      const doc = await db.collection('stores').doc(id).get();
      if (doc.exists) storeData = doc.data();
    } else if (name) {
      const snapshot = await db.collection('stores').where('name', '==', name).limit(1).get();
      if (!snapshot.empty) storeData = snapshot.docs[0].data();
    }

    if (!storeData) return res.status(404).json({ result: '데이터 없음' });

    const { clicks = 0, views = 0, premium } = storeData;
    let result, level;

    if (clicks > 100) {
      result = '🔥 매우 활성화된 업체! 지금 프리미엄 광고로 전환하면 매출 2배 기대 가능합니다.';
      level  = 'hot';
    } else if (clicks > 30) {
      result = '📈 고객 관심도 높음 → 할인 이벤트 또는 라이브 방송 참여를 추천합니다.';
      level  = 'warm';
    } else if (views > 100) {
      result = '👀 노출은 많으나 클릭 전환이 낮습니다 → 업체 소개 문구 개선을 추천합니다.';
      level  = 'mid';
    } else {
      result = '📢 노출이 부족합니다 → 광고 등록 또는 카테고리 재설정을 추천합니다.';
      level  = 'low';
    }

    res.json({ result, level, clicks, views, premium });
  } catch (err) {
    console.error('[GET /api/ai-recommend]', err);
    res.status(500).json({ error: '추천 분석 오류' });
  }
});

/* ============================================================
   📊 통계  GET /api/stats
============================================================ */
app.get('/api/stats', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const snapshot  = await db.collection('stores').get();
    const stores    = snapshot.docs.map(d => d.data());
    const total     = stores.length;
    const premium   = stores.filter(s => s.premium).length;
    const totalClicks = stores.reduce((sum, s) => sum + (s.clicks || 0), 0);
    const totalViews  = stores.reduce((sum, s) => sum + (s.views  || 0), 0);

    // 카테고리별 집계
    const catMap = {};
    stores.forEach(s => {
      if (s.category) catMap[s.category] = (catMap[s.category] || 0) + 1;
    });

    res.json({ total, premium, totalClicks, totalViews, categories: catMap });
  } catch (err) {
    console.error('[GET /api/stats]', err);
    res.status(500).json({ error: '통계 조회 오류' });
  }
});

/* ============================================================
   🛡 관리자: 업체 심사 승인  POST /api/admin/approve
   (실제 운영 시 인증 미들웨어 추가 필요)
============================================================ */
app.post('/api/admin/approve', async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const { id } = req.body;
    await db.collection('stores').doc(id).update({ approved: true });
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/admin/approve]', err);
    res.status(500).json({ error: '승인 오류' });
  }
});

/* ============================================================
   404 → index.html (SPA 폴백)
============================================================ */
// '*' 대신 '(.*)'를 사용해야 합니다.
app.get('(.*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── 서버 기동 ── */
app.listen(PORT, () => {
  console.log(`🚀 AI플랫마켓 서버 실행 중 → http://localhost:${PORT}`);
});