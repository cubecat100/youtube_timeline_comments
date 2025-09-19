/************************************************************
 *  1) 타임스탬프 없는 댓글은 수집/표시하지 않음
 *  2) 타임스탬프가 있으면 모두 수집하되,
 *     - 문장 맨 앞이 타임스탬프로 시작 > 타임라인 (평탄화) > 화면에 표시
 *     - 그렇지 않음 > "보조" > 표시하지는 않음
 *  3) 한 댓글에 여러 타임스탬프가 있으면: 각 타임스탬프 기준으로 쪼개 개별 항목으로 분할
 ************************************************************/

const LOG_PREFIX = "[YT-TC:FINAL]";
function log(...a) { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }
function byId(id) { return document.getElementById(id); }

// === Debug Console ===
window.TLDBG = window.TLDBG || {
  enabled: true,
  verbose: false,
  log(...a) { if (this.enabled) console.log('[TL]', ...a); },
  v(...a) { if (this.enabled && this.verbose) console.debug('[TL+]', ...a); },
  setVerbose(v) { this.verbose = !!v; this.log('verbose =', this.verbose); },
  setEnabled(e) { this.enabled = !!e; this.log('enabled =', this.enabled); },
};

// 오버레이 옵션
window.__TL_OVERLAY_OPTS = Object.assign({
  align: 'right',      // 'right' | 'left'
  maxWidthRatio: 0.4,  // overlay 최대 가로 = video.width * 비율 (최대 900px)
  fontSizePx: 14,      // 코멘트 폰트 크기(px)
  bgOpacity: 0.65,     // 코멘트 배경 불투명도 0..1
  sideGapPx: 16,       // 영상 좌/우측 여백(px)
  bottomGapRatio: 0.15,// 영상 하단 여백 비율
  topGapRatio: 0.15,   // 영상 상단 여백 비율
  overflowMode: 'prune', // 'prune' | 'mask'
  maxItems: 7          // 'prune' 모드에서 최대 표시 버블 개수
}, window.__TL_OVERLAY_OPTS || {});

// 모드별 오버레이 옵션 오버라이드
window.__TL_OVERLAY_MODE_OPTS = Object.assign({
  default: { maxWidthRatio: 0.40 },
  theater: { maxWidthRatio: 0.33 },
  fullscreen: { maxWidthRatio: 0.33, bottomGapRatio: 0.1, topGapRatio: 0.1, maxItems: 10, fontSizePx: 18 }
}, window.__TL_OVERLAY_MODE_OPTS || {});

function __tl_getViewMode() {
  if (document.fullscreenElement) return 'fullscreen';
  const flexy = document.querySelector('ytd-watch-flexy');
  return (flexy && flexy.hasAttribute('theater')) ? 'theater' : 'default';
}

// 타임라인 주입형식
window.__TIMELINE_RAW = window.__TIMELINE_RAW || [];

function __tl_mergeWithBase(raw) {
  const injected = Array.isArray(raw) ? raw : window.__TIMELINE_RAW;
  return injected || [];
}

/* -------------------------------
   페이지에서 ytcfg 값 요청
-------------------------------- */

(() => {
  const isWatchLike = () =>
    location.pathname.startsWith("/watch");
  if (!isWatchLike()) return;

  // inject.js 주입(중복 방지)
  if (!window.__ytcc_injected__) {
    window.__ytcc_injected__ = true;
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/inject.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  let lastVid = null;

  // 현재 영상 id 추출
  function getVid() {
    try {
      const v = new URL(location.href).searchParams.get("v");
      if (v) return v; // watch
      const m = location.pathname.match(/^\/shorts\/([\w-]{5,})/);
      if (m && m[1]) return m[1]; // shorts
      const flexy = document.querySelector("ytd-watch-flexy");
      const flexyVid = flexy?.getAttribute("video-id");
      if (flexyVid) return flexyVid; // fallback
    } catch { }
    return null;
  }

  // 수집 시작(풀 드레인: 결과는 한꺼번에 전달)
  function startDrain() {
    window.postMessage({
      type: "YTCC_START",
      opts: {
        forceDrain: true,
        maxComments: 100000,
        hardStopMs: 5 * 60 * 1000,
        maxIdleMs: 8000,
        throttleMs: 120
      }
    }, "*");
  }

  // inject.js와 메시지 연결
  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || !ev.data) return;
    const { type, payload } = ev.data;

    if (type === "YTCC_READY") {
      // 준비 완료 메시지 > 현재 영상으로 수집 시작
      lastVid = getVid();
      startDrain();
      return;
    } else if (type === "YTCC_TEXTS_ONLY") {
      //결과 반환 메시지
      TLDBG.log("comments loaded : " + payload.length);
      //TLDBG.log("comments : " + payload);

      if (typeof __timeline_update === "function"
        && typeof parseLeadingSegments === "function"
        && typeof normalizeComments === "function") {

        const segs = (Array.isArray(payload) ? payload : [payload]).flatMap(t => parseLeadingSegments(t));
        const raw = segs.map(s => ({ timeSec: s.seconds, text: s.text }));
        __timeline_update(normalizeComments(raw));
        rescanAndRender(); // 패널 강제 갱신
      }
      return;
    }
  });

  // 다른영상으로 바뀌면 자동 재시작
  function maybeRestart() {
    const vid = getVid();
    if (!vid || vid === lastVid) return;
    lastVid = vid;
    startDrain();
  }

  // YouTube SPA 전환 감지
  (function watchFlexy() {
    const flexy = document.querySelector("ytd-watch-flexy");
    if (!flexy) { setTimeout(watchFlexy, 500); return; }
    lastVid = getVid();
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "video-id") {
          maybeRestart();
        }
      }
    }).observe(flexy, { attributes: true, attributeFilter: ["video-id"] });
  })();
  document.addEventListener("yt-navigate-finish", () => maybeRestart(), true);
  window.addEventListener("popstate", () => setTimeout(maybeRestart, 0));
})();

/* -------------------------------
   타임스탬프 파싱 유틸
-------------------------------- */
const TS_ANY = /(\d{1,3}:[0-5]?\d(?::[0-5]\d)?)/g;         // m:ss or h:mm:ss
const TS_HEAD = /^(\d{1,3}:[0-5]?\d(?::[0-5]\d)?)/;         // 문장 맨 앞 TS 여부

function tsToSeconds(tsStr) {
  const p = tsStr.split(":").map(Number);
  if (p.some(n => Number.isNaN(n))) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
function fmtDisplay(tsStr) {
  const p = tsStr.split(":").map(Number);
  return p.length === 3
    ? `${p[0]}:${String(p[1]).padStart(2, "0")}:${String(p[2]).padStart(2, "0")}`
    : `${p[0]}:${String(p[1]).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[m]));
}
function parseTimestamp(ts) {
  if (ts == null) return NaN;

  // 숫자 그대로 허용
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : NaN;

  // 문자열: "SS" | "MM:SS" | "HH:MM:SS" | "73.408" 등
  if (typeof ts === 'string') {
    const s = ts.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s); // 순수 숫자 문자열
    const parts = s.split(':').map(Number);
    if (parts.some(n => Number.isNaN(n))) return NaN;

    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  // 객체 형태 지원
  if (typeof ts === 'object') {
    if ('timeSec' in ts) return parseTimestamp(ts.timeSec);
    if ('seconds' in ts) return parseTimestamp(ts.seconds);
    if ('time' in ts) return parseTimestamp(ts.time);
    if ('ts' in ts) return parseTimestamp(ts.ts);
    if ('timestamp' in ts) return parseTimestamp(ts.timestamp);
  }

  // 마지막 폴백: 숫자 변환 시도
  const n = Number(ts);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeComments(raw) {
  return (raw || [])
    .map(r => {
      const tRaw =
        r.time ?? r.ts ?? r.timestamp ?? r.timeSec ?? r.seconds ?? r.key ?? null;
      const text = r.text ?? r.content ?? r.body ?? r.comment ?? r.msg ?? '';
      return { timeSec: parseTimestamp(tRaw), text: String(text) };
    })
    .filter(x => Number.isFinite(x.timeSec))
    .sort((a, b) => a.timeSec - b.timeSec);
}

function createOverlay() {
  let wrap = document.getElementById('timeline-comment-overlay');
  if (wrap) return wrap;

  wrap = document.createElement('div');
  wrap.id = 'timeline-comment-overlay';
  Object.assign(wrap.style, {
    position: 'fixed',
    left: '50%', transform: 'translateX(-50%)',
    bottom: '15%',
    width: '70%', maxWidth: '900px',
    display: 'flex', flexDirection: 'column', gap: '8px',
    alignItems: 'center', justifyContent: 'flex-end',
    pointerEvents: 'none',
    zIndex: 2147483647
  });
  document.body.appendChild(wrap);
  return wrap;
}

function showComment(overlay, text, timeSec) {
  if (!overlay) { TLDBG.log('overlay missing'); return; }
  TLDBG.v('render', { timeSec, text: String(text).slice(0, 80) });

  const item = document.createElement('div');
  Object.assign(item.style, {
    background: 'rgba(0,0,0,' + ((window.__TL_OVERLAY_OPTS?.bgOpacity ?? 0.65)) + ')', color: '#fff',
    borderRadius: '12px', padding: '8px 12px',
    // 모드별 폰트 크기
    fontSize: String((window.__TL_OVERLAY_MODE_OPTS?.[__tl_getViewMode()]?.fontSizePx) ?? (window.__TL_OVERLAY_OPTS?.fontSizePx ?? 14)) + 'px',
    maxWidth: '100%', transform: 'translateY(0)',
    opacity: '1', transition: 'opacity .5s ease, transform .5s ease',
    pointerEvents: 'auto', cursor: 'pointer'
  });
  item.textContent = text;

  const ts = Number(timeSec);
  item.addEventListener('click', () => {
    if (Number.isFinite(ts)) {
      window.seekTo(ts, { autoplay: true });
    } else {
      console.warn('Invalid timeSec:', timeSec);
    }
  });

  overlay.appendChild(item);
  overlay.__tl_enforceOverflowPolicy?.();

  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(-10px)';
    setTimeout(() => item.remove(), 500);
  }, 5000);
}

// =============================================
// 주입형 오버레이: 외부에서 __timeline_update([...])로 공급
//  - 비디오가 아직 없으면 window.__TIMELINE_RAW 에 캐시해두고 대기
//  - 비디오가 생기면 bootOverlayWith()가 캐시 폴백으로 플레이어 시작
// =============================================
function getOverlayHost() { return document.fullscreenElement || document.body; }

function bootOverlayWith(raw) {
  const video = document.querySelector('video');
  if (!video) {
    if (raw) window.__TIMELINE_RAW = raw; // 나중에 사용
    TLDBG.log('no <video> yet; queued comments');
    return;
  }
  // 오버레이 생성(+ 풀스크린 시 host로 부착)
  let overlay = document.getElementById('timeline-comment-overlay');

  function activeOpts() {
    const m = __tl_getViewMode();
    return Object.assign({}, window.__TL_OVERLAY_OPTS || {}, (window.__TL_OVERLAY_MODE_OPTS || {})[m] || {});
  }
  const base = () => activeOpts();

  // 전환/애니메이션 직후 레이아웃 안정화용 rAF 번갈아 호출
  function __tl_scheduleReflow() {
    let n = 0;
    const step = () => { placeOverlay(); if (++n < 3) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    setTimeout(placeOverlay, 300);
  }

  // 넘침 처리 유틸: 높이/마스킹
  function calcHeights(r, a) {
    const topGap = Math.round(r.height * (a.topGapRatio ?? 0.10));
    const bottomGap = Math.round(r.height * (a.bottomGapRatio ?? 0.15));
    return { topGap, bottomGap, maxH: Math.max(50, r.height - topGap - bottomGap) };
  }

  function placeOverlay() {
    const r = video.getBoundingClientRect();
    const a = base();
    const maxW = Math.min(Math.round(r.width * (a.maxWidthRatio ?? 0.4)), 900);
    const { topGap, bottomGap, maxH } = calcHeights(r, a);
    const leftPx = (a.align === 'left')
      ? Math.round(r.left + (a.sideGapPx ?? 16))
      : Math.round(r.right - maxW - (a.sideGapPx ?? 16));
    const bottomPx = Math.round((window.innerHeight - r.bottom) + bottomGap);
    Object.assign(overlay.style, {
      left: leftPx + 'px',
      bottom: bottomPx + 'px',
      width: maxW + 'px',
      maxHeight: maxH + 'px',
      overflow: 'hidden',
      alignItems: (a.align === 'left') ? 'flex-start' : 'flex-end',
    });
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'timeline-comment-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      display: 'flex', flexDirection: 'column', gap: '8px',
      justifyContent: 'flex-end',
      pointerEvents: 'none', zIndex: 999999
    });
    getOverlayHost().appendChild(overlay);
  } else if (overlay.parentNode !== getOverlayHost()) {
    getOverlayHost().appendChild(overlay);
  }

  // 최초/재부착 후 위치 반영 + 리스너 1회만 부착
  overlay.style.visibility = 'visible';
  __tl_scheduleReflow();
  if (!overlay.__tl_reposAttached) {
    overlay.__tl_reposAttached = true;
    const __tl_repos = () => placeOverlay();
    window.addEventListener('resize', __tl_repos, { passive: true });
    window.addEventListener('scroll', __tl_repos, { passive: true });
    document.addEventListener('fullscreenchange', __tl_repos);
    // 영화관 모드 토글 감시
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy) {
      const mo = new MutationObserver(__tl_repos);
      mo.observe(flexy, { attributes: true, attributeFilter: ['theater'] });
      overlay.__tl_modeMo = mo;
    }

    // 비디오 크기 변화 감지(모드 전환·반응형 단계에서 필수)
    try {
      const ro = new ResizeObserver(__tl_repos);
      ro.observe(video);
      overlay.__tl_ro = ro;
    } catch (_) { /* Safari 등 미지원 시 무시 */ }
    // 플레이어 컨테이너 트랜지션 종료에도 반응
    const playerHost =
      document.getElementById('player-container-inner') ||
      document.querySelector('#player-container, ytd-player, #movie_player');
    playerHost && playerHost.addEventListener('transitionend', __tl_repos, { passive: true });
  }

  // 넘침 처리: 프루닝 정책
  overlay.__tl_enforceOverflowPolicy = function enforceOverflowPolicy() {
    const mode = (window.__TL_OVERLAY_OPTS?.overflowMode) || 'prune';
    if (mode !== 'prune') return; // 'mask'는 overflow:hidden으로 가림
    const maxItems = window.__TL_OVERLAY_OPTS?.maxItems ?? 6;
    // 1) 개수 제한 우선
    while (overlay.childElementCount > maxItems) {
      overlay.firstElementChild?.remove();
    }
    // 2) 높이 초과 시 가장 오래된 버블부터 제거
    let guard = 50; // 안전 상한
    while (overlay.scrollHeight > overlay.clientHeight && overlay.childElementCount > 0 && guard-- > 0) {
      overlay.firstElementChild?.remove();
    }
  };

  const comments = normalizeComments(__tl_mergeWithBase(raw));
  if (window.__timelinePlayer) { try { window.__timelinePlayer.destroy(); } catch (e) { } }
  if (typeof TimelineCommentPlayer !== 'function') { queueMicrotask(() => bootOverlayWith(raw)); return; }
  window.__timelinePlayer = new TimelineCommentPlayer(video, comments, overlay, 0.35);
  TLDBG.log('player init', { count: comments.length });
}

// 비디오가 늦게 생겨도 자동 부팅
(function autoBoot() {
  if (document.querySelector('video')) {
    queueMicrotask(() => bootOverlayWith());
    return;
  }
  const mo = new MutationObserver(() => {
    if (document.querySelector('video')) { mo.disconnect(); bootOverlayWith(); }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();

// 풀스크린 전환 시 오버레이를 대상 엘리먼트로 이동
document.addEventListener('fullscreenchange', () => {
  const ov = document.getElementById('timeline-comment-overlay');
  if (ov && ov.parentNode !== getOverlayHost()) getOverlayHost().appendChild(ov);
});

window.__timeline_update = function (raw) {
  window.__TIMELINE_RAW = raw || [];
  window.__TIMELINE_INJECTED = Array.isArray(raw) && raw.length > 0;

  if (!window.__timelinePlayer) {
    if (document.querySelector('video')) bootOverlayWith(raw);
    else TLDBG.log('queued comments (waiting for <video>)');
    return;
  }

  const p = window.__timelinePlayer;
  p.comments = normalizeComments(__tl_mergeWithBase(raw));
  p.idx = p._lowerBound(p.comments, p.video.currentTime - p.tolerance, c => c.timeSec);
  TLDBG.log('comments updated', { total: p.comments.length, idx: p.idx });
  //TLDBG.log(p.comments);
};

class TimelineCommentPlayer {
  constructor(video, comments, overlay, tolerance = 0.35) {
    this.video = video;
    this.comments = comments;
    this.overlay = overlay;
    this.tolerance = tolerance;
    this.idx = 0;
    this.lastT = 0;
    this._rafId = null;

    this._onPlay = this._onPlay.bind(this);
    this._onPause = this._onPause.bind(this);
    this._onSeeking = this._onSeeking.bind(this);
    this._tick = this._tick.bind(this);

    video.addEventListener('play', this._onPlay);
    video.addEventListener('pause', this._onPause);
    video.addEventListener('seeking', this._onSeeking);

    // === 디버그 API (콘솔에서 호출) ===
    this.status = () => ({
      playing: !this.video.paused,
      curT: this.video.currentTime,
      lastT: this.lastT,
      idx: this.idx,
      total: this.comments.length,
      next: this.comments[this.idx]?.timeSec ?? null,
      tol: this.tolerance,
      rafOn: !!this._rafId,
    });

    this.debug = {
      dump: () => console.table(this.comments.map((c, i) => ({ i, timeSec: c.timeSec, text: c.text?.slice(0, 60) }))),
      checkComments: () => {
        const bad = this.comments.find(c => !Number.isFinite(c.timeSec));
        const sorted = this.comments.every((c, i, a) => i === 0 || a[i - 1].timeSec <= c.timeSec);
        TLDBG.log('comments sorted=', sorted, 'total=', this.comments.length, bad ? 'invalid found' : '');
        if (bad) console.warn('Invalid item:', bad);
      },
      nearby: (range = 2) => {
        const t = this.video.currentTime;
        const around = this.comments.filter(c => Math.abs(c.timeSec - t) <= range);
        console.table(around.map(c => ({ timeSec: c.timeSec, text: c.text?.slice(0, 80) })));
        return around;
      },
      jumpToNext: () => {
        const n = this.comments[this.idx];
        if (!n) return TLDBG.log('no next comment');
        window.seekTo?.(n.timeSec, { autoplay: true });
      },
      jumpToPrev: () => {
        const cur = this.video.currentTime;
        let i = this._lowerBound(this.comments, cur - 0.01, c => c.timeSec) - 1;
        if (i < 0) return TLDBG.log('no prev comment');
        window.seekTo?.(this.comments[i].timeSec, { autoplay: true });
      },
      forceRender: (text = 'TEST', t = this.video.currentTime) => showComment(this.overlay, text, t),
      setTolerance: (x) => { this.tolerance = Number(x); TLDBG.log('tolerance =', this.tolerance); },
    };

    TLDBG.log('player init', { count: comments.length, first: comments[0]?.timeSec, last: comments.at(-1)?.timeSec, tol: tolerance });

    if (!video.paused) this._onPlay();
  }

  destroy() {
    this.video.removeEventListener('play', this._onPlay);
    this.video.removeEventListener('pause', this._onPause);
    this.video.removeEventListener('seeking', this._onSeeking);
    cancelAnimationFrame(this._rafId);
  }

  _onPlay() {
    this.lastT = this.video.currentTime;
    const step = () => { this._rafId = requestAnimationFrame(step); this._tick(); };
    this._rafId = requestAnimationFrame(step);
    TLDBG.v('onPlay @', this.lastT);
  }
  _onPause() {
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    TLDBG.v('onPause');
  }
  _onSeeking() {
    const tgt = this.video.currentTime - this.tolerance;
    this.idx = this._lowerBound(this.comments, tgt, c => c.timeSec);
    this.lastT = this.video.currentTime;
    TLDBG.v('onSeeking -> idx', this.idx, 'curT', this.lastT.toFixed(3));
  }

  _tick() {
    const curT = this.video.currentTime;

    if (curT >= this.lastT) {
      //let emitted = 0;
      while (this.idx < this.comments.length) {
        const next = this.comments[this.idx];
        if (next.timeSec <= curT + this.tolerance) {
          if (next.timeSec >= this.lastT - this.tolerance) {
            showComment(this.overlay, next.text, next.timeSec);
            //emitted++;
          }
          this.idx++;
        } else break;
      }

      // if (emitted) TLDBG.log(`emit x${emitted} @${curT.toFixed(3)} idx=${this.idx}`);
      // else TLDBG.v('no emit between', this.lastT.toFixed(3), '→', curT.toFixed(3));

    } else {
      // 뒤로 점프
      this.idx = this._lowerBound(this.comments, curT - this.tolerance, c => c.timeSec);
      TLDBG.v('rewind -> idx', this.idx);
    }

    this.lastT = curT;
  }

  _lowerBound(arr, target, get = v => v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (get(arr[mid]) < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
}

// 문장 맨 앞부터 TS로 시작하는 경우만 쪼개기
function parseLeadingSegments(fullText) {
  if (!fullText) return [];
  const text = fullText.trim();
  if (!TS_HEAD.test(text)) return [];

  const anchors = [];
  TS_ANY.lastIndex = 0;
  let m;
  while ((m = TS_ANY.exec(text)) !== null) anchors.push({ idx: m.index, ts: m[1] });
  if (anchors.length === 0) return [];

  const segs = [];
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i], next = anchors[i + 1];
    const start = cur.idx + cur.ts.length;
    const end = next ? next.idx : text.length;
    const body = text.slice(start, end).replace(/^[\s\-–—:|>]+/, "").trim();
    const sec = tsToSeconds(cur.ts);
    if (sec == null || !body) continue;
    segs.push({ seconds: sec, display: fmtDisplay(cur.ts), text: body });
  }
  return segs;
}

// 위치 무관: 텍스트 내 모든 TS를 쪼개기 
function parseAllSegments(fullText) {
  if (!fullText) return [];
  const text = fullText.trim();

  const anchors = [];
  TS_ANY.lastIndex = 0;
  let m;
  while ((m = TS_ANY.exec(text)) !== null) anchors.push({ idx: m.index, ts: m[1] });
  if (anchors.length === 0) return [];

  const segs = [];
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i], next = anchors[i + 1];
    const start = cur.idx + cur.ts.length;
    const end = next ? next.idx : text.length;
    const body = text.slice(start, end).replace(/^[\s\-–—:|>]+/, "").trim();
    const sec = tsToSeconds(cur.ts);
    if (sec == null || !body) continue;
    segs.push({ seconds: sec, display: fmtDisplay(cur.ts), text: body });
  }
  return segs;
}

// /* -------------------------------
//    댓글 DOM 접근
// -------------------------------- */
function getAllCommentNodes() {
  const vm = Array.from(document.querySelectorAll("ytd-comment-view-model"));
  const old = Array.from(document.querySelectorAll("ytd-comment-thread-renderer ytd-comment-renderer"));
  return vm.length > 0 ? vm : old;
}

function getCommentTextFromNode(node) {
  const a = node.querySelector?.(".yt-core-attributed-string");
  if (a?.innerText) return a.innerText.trim();
  const b = node.querySelector?.("yt-formatted-string#content-text");
  if (b?.innerText) return b.innerText.trim();
  return "";
}

/* -------------------------------
   상태 저장
-------------------------------- */
const nodeUidMap = new WeakMap(); 
let nextUid = 1;

function getNodeUid(n) {
  let id = nodeUidMap.get(n);
  if (!id) { 
    id = nextUid++; 
    nodeUidMap.set(n, id); 
  }
  return id;
}

// function textHash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h.toString(16); }

// // 메인(선행 TS) 평탄 리스트
// const leadingItems = [];   // { seconds, display, text, uid }
// // 보조(비선행) 댓글 단위 묶음: uid -> { text, chips: Map(sec -> {display, text}) }
// const nonLeadingStore = new Map();

// // 중복 방지
// const seen = new Set();    // key: `${uid}::L/N::${seconds}::${hash(text)}`

// /* -------------------------------
//    스캐닝
// -------------------------------- */
function handleCommentNode(node) {
  const text = getCommentTextFromNode(node);
  if (!text) return 0;

  const uid = getNodeUid(node);
  let added = 0;

  if (TS_HEAD.test(text)) {
    // 메인(선행) 섹션
    const segs = parseLeadingSegments(text);
    for (const seg of segs) {
      const key = `${uid}::L::${seg.seconds}::${textHash(seg.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leadingItems.push({ seconds: seg.seconds, display: seg.display, text: seg.text, uid });
      added++;
    }
  } else {
    // 보조(비선행) 섹션: 댓글 단위로 칩 묶음
    const segs = parseAllSegments(text);
    if (segs.length === 0) return 0;
    let entry = nonLeadingStore.get(uid);
    if (!entry) { entry = { text, chips: new Map() }; nonLeadingStore.set(uid, entry); }
    for (const seg of segs) {
      const key = `${uid}::N::${seg.seconds}::${textHash(seg.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 같은 초 중복 방지, 마지막 텍스트 보존
      entry.chips.set(seg.seconds, { display: seg.display, text: seg.text });
      added++;
    }
  }

  return added;
}

function scanOnce(withLog = true) {
  const nodes = getAllCommentNodes();
  let total = 0;
  for (const n of nodes) total += handleCommentNode(n);
  if (withLog) log(`스캔: nodes=${nodes.length}, 선행추가=${total}, 메인=${leadingItems.length}, 보조댓글=${nonLeadingStore.size}`);
  return total;
}

// // 스캔 결과(leadingItems, nonLeadingStore) → 오버레이용 [{time, text}]로 변환
// function buildOverlayTimeline(leadingItems, nonLeadingStore) {
//   const out = [];

//   // 1) 선행 타임스탬프(댓글 앞부분에 있는 시간)
//   (leadingItems || []).forEach(it => {
//     const sec =
//       it.seconds ?? it.timeSec ??
//       (typeof parseTimestamp === 'function' ? parseTimestamp(it.time ?? it.ts ?? it.timestamp) : Number(it.time ?? it.ts ?? it.timestamp));
//     const txt = it.text ?? it.content ?? it.body ?? it.comment ?? it.msg ?? '';
//     if (Number.isFinite(sec)) out.push({ time: sec, text: String(txt) });
//   });

//   // 2) 비선행 타임스탬프(칩/본문 중간 등)
//   if (nonLeadingStore) {
//     const entries = nonLeadingStore instanceof Map
//       ? Array.from(nonLeadingStore.values())
//       : Array.isArray(nonLeadingStore)
//         ? nonLeadingStore
//         : Object.values(nonLeadingStore);

//     entries.forEach(e => {
//       const chips = e.chips ?? e.times ?? e.timestamps ?? e.timeChips;
//       const baseText = e.text ?? e.content ?? e.body ?? e.comment ?? e.msg ?? '';

//       if (chips instanceof Map) {
//         chips.forEach((info, k) => {
//           const sec = Number(k) ?? (typeof parseTimestamp === 'function' ? parseTimestamp(k) : Number(k));
//           const txt = (info && (info.text ?? info.label)) ?? baseText;
//           if (Number.isFinite(sec)) out.push({ time: sec, text: String(txt || '') });
//         });
//       } else if (Array.isArray(chips)) {
//         chips.forEach(c => {
//           const sec =
//             c.seconds ?? c.timeSec ??
//             (typeof parseTimestamp === 'function' ? parseTimestamp(c.time ?? c.ts ?? c.timestamp) : Number(c.time ?? c.ts ?? c.timestamp));
//           const txt = c.text ?? c.label ?? baseText;
//           if (Number.isFinite(sec)) out.push({ time: sec, text: String(txt || '') });
//         });
//       } else if (chips && typeof chips === 'object') {
//         Object.entries(chips).forEach(([k, v]) => {
//           const sec = Number(k) ?? (typeof parseTimestamp === 'function' ? parseTimestamp(k) : Number(k));
//           const txt = (v && (v.text ?? v.label)) ?? baseText;
//           if (Number.isFinite(sec)) out.push({ time: sec, text: String(txt || '') });
//         });
//       }
//     });
//   }

//   // 정렬 + 중복 정리(같은 시점 같은 텍스트 중복 제거)
//   out.sort((a, b) => (a.time - b.time) || a.text.localeCompare(b.text));
//   const dedup = [];
//   let prev = null;
//   for (const x of out) {
//     if (!prev || prev.time !== x.time || prev.text !== x.text) dedup.push(x);
//     prev = x;
//   }
//   return dedup;
// }

// // 오버레이에 실제 반영 (주입형 API가 있으면 그걸 쓰고, 없으면 직접 교체)
// function pushScanToOverlay(leadingItems, nonLeadingStore) {
//   const timeline = buildOverlayTimeline(leadingItems, nonLeadingStore);
//   if (!timeline.length) {
//     console.log('[TL] scan produced 0 items (skip)');
//     return;
//   }

//   if (typeof window.__timeline_update === 'function') {
//     // 주입형 경로 사용
//     window.__timeline_update(timeline);
//   } else if (window.__timelinePlayer && typeof normalizeComments === 'function') {
//     // 주입형 API가 없으면 직접 현재 플레이어에 반영
//     const p = window.__timelinePlayer;
//     p.comments = normalizeComments(timeline);
//     p.idx = p._lowerBound(p.comments, p.video.currentTime - p.tolerance, c => c.timeSec);
//   } else {
//     // 최후의 수단: 전역 캐시만 갱신 (초기 부팅 시 폴백으로 쓰이게)
//     window.__TIMELINE_RAW = timeline;
//   }
//   console.log('[TL] overlay updated from scan:', timeline.length);
// }

// /* -------------------------------
//    UI (패널/렌더)
// -------------------------------- */
// function ensureFab() {
//   if (byId("yt-tc-fab")) return;
//   const fab = document.createElement("div");
//   fab.id = "yt-tc-fab";
//   fab.title = "댓글 타임스탬프 패널 열기/닫기";
//   fab.textContent = "⏱";
//   fab.addEventListener("click", () => {
//     const p = byId("yt-tc-panel");
//     if (p) p.style.display = p.style.display === "none" ? "flex" : "none";
//   });
//   document.documentElement.appendChild(fab);
// }
// function ensurePanel() {
//   if (byId("yt-tc-panel")) return;
//   const root = document.createElement("div");
//   root.id = "yt-tc-panel";
//   root.innerHTML = `
//     <div class="ytc-header">
//       <div class="ytc-title">타임스탬프 타임라인</div>
//       <button class="ytc-btn" id="ytc-rescan">재스캔</button>
//       <button class="ytc-btn" id="ytc-close">닫기</button>
//     </div>
//     <div class="ytc-list" id="ytc-list"></div>
//   `;
//   document.documentElement.appendChild(root);
//   // 기본 닫힘
//   root.style.display = "none";

//   byId("ytc-close").addEventListener("click", () => { root.style.display = "none"; });
//   byId("ytc-rescan").addEventListener("click", () => { rescanAndRender(); });
// }

// function renderList() {
//   const list = byId("ytc-list");
//   if (!list) return;

//   // 메인(선행) 정렬
//   const main = [...leadingItems].sort((a, b) => a.seconds - b.seconds);
//   // 보조(비선행) 정렬: 각 댓글의 최소 초 기준
//   const aux = Array.from(nonLeadingStore.entries()).map(([uid, entry]) => {
//     const chips = Array.from(entry.chips.entries()) // [sec, {display,text}]
//       .sort((a, b) => a[0] - b[0]);
//     const firstSec = chips.length ? chips[0][0] : Number.MAX_SAFE_INTEGER;
//     return { uid, text: entry.text, chips, firstSec };
//   }).sort((a, b) => a.firstSec - b.firstSec);

//   const sectionMain = `
//     <div style="display:flex;gap:8px;align-items:center;margin:6px 0 4px;">
//       <div style="font-weight:700;">메인(선행 타임스탬프)</div>
//       <div style="opacity:.7;">(${main.length})</div>
//     </div>
//     <div id="ytc-timeline-list">
//       ${main.map(it => `
//         <div class="ytc-item" data-time="${it.seconds}">
//           <div class="ytc-time">${it.display}</div>
//           <div class="ytc-text">${escapeHtml(it.text)}</div>
//         </div>`).join("")}
//     </div>
//   `;

//   const sectionAux = `
//     <div style="display:flex;gap:8px;align-items:center;margin:10px 0 4px;">
//       <div style="font-weight:700;">보조(비선행 타임스탬프 · 댓글 묶음)</div>
//       <div style="opacity:.7;">(${aux.length})</div>
//     </div>
//     <div id="ytc-aux-list">
//       ${aux.map(g => `
//         <div class="ytc-item" data-uid="${g.uid}">
//           <div class="ytc-time" style="opacity:.5;">⋯</div>
//           <div>
//             <div class="ytc-text">${escapeHtml(g.text)}</div>
//             <div class="ytc-chips">
//               ${g.chips.map(([sec, info]) => `
//                 <span class="ytc-chip" data-time="${sec}" title="${escapeHtml(info.text)}">${info.display}</span>
//               `).join("")}
//             </div>
//           </div>
//         </div>
//       `).join("")}
//     </div>
//   `;

//   list.innerHTML = sectionMain + sectionAux;

//   // 메인 항목 클릭 → 시킹
//   list.querySelectorAll("#ytc-timeline-list .ytc-item").forEach(el => {
//     el.addEventListener("click", () => seekTo(Number(el.dataset.time)));
//   });
//   // 보조 칩 클릭 → 시킹 (카드 클릭은 첫 칩으로 이동)
//   list.querySelectorAll("#ytc-aux-list .ytc-item").forEach(card => {
//     const chips = card.querySelectorAll(".ytc-chip");
//     card.addEventListener("click", (ev) => {
//       if (ev.target.closest(".ytc-chip")) return; // 칩 자체 클릭이면 카드 핸들러 무시
//       const firstChip = chips[0];
//       if (firstChip) seekTo(Number(firstChip.dataset.time));
//     });
//     chips.forEach(chip => {
//       chip.addEventListener("click", (ev) => {
//         ev.stopPropagation();
//         seekTo(Number(chip.dataset.time));
//       });
//     });
//   });

//   highlightByCurrentTime();

//   pushScanToOverlay(leadingItems, nonLeadingStore);
// }

// /* 재생 위치에 가장 가까운 항목/칩 하이라이트 */
// function highlightByCurrentTime() {
//   const v = document.querySelector("video");
//   const list = byId("ytc-list");
//   if (!v || !list) return;

//   const now = v.currentTime;

//   // 후보: 메인 아이템 + 보조 칩
//   const mainItems = Array.from(list.querySelectorAll("#ytc-timeline-list .ytc-item"));
//   const auxChips = Array.from(list.querySelectorAll("#ytc-aux-list .ytc-chip"));

//   let bestEl = null, bestDelta = Infinity, bestType = null;

//   for (const el of mainItems) {
//     const t = Number(el.dataset.time);
//     const d = Math.abs(t - now);
//     if (d < bestDelta && d <= 2.0) { bestEl = el; bestDelta = d; bestType = "main"; }
//   }
//   for (const chip of auxChips) {
//     const t = Number(chip.dataset.time);
//     const d = Math.abs(t - now);
//     if (d < bestDelta && d <= 2.0) { bestEl = chip; bestDelta = d; bestType = "chip"; }
//   }

//   // 리셋
//   mainItems.forEach(el => el.classList.remove("active"));
//   auxChips.forEach(chip => chip.classList.remove("active"));
//   Array.from(list.querySelectorAll("#ytc-aux-list .ytc-item")).forEach(card => card.classList.remove("active"));

//   // 적용
//   if (bestEl && bestType === "main") {
//     bestEl.classList.add("active");
//   } else if (bestEl && bestType === "chip") {
//     bestEl.classList.add("active");
//     bestEl.closest(".ytc-item")?.classList.add("active");
//   }
// }

// /* 주기적 동기 */
// let syncTimer = null;
// function startSyncTimer() {
//   if (syncTimer) return;
//   syncTimer = setInterval(highlightByCurrentTime, 500);
// }

// /* -------------------------------
//    관찰자 / 네비게이션 대응
// -------------------------------- */
// function startObservers() {
//   scanOnce();
//   // ensureFab();
//   // ensurePanel();
//   renderList();
//   startSyncTimer();

//   const obs = new MutationObserver((muts) => {
//     let added = 0;
//     for (const m of muts) {
//       for (const node of m.addedNodes) {
//         if (!(node instanceof HTMLElement)) continue;
//         if (node.matches?.("ytd-comment-view-model, ytd-comment-renderer")) {
//           added += handleCommentNode(node);
//           node.querySelectorAll?.("ytd-comment-view-model, ytd-comment-renderer")
//             .forEach(sub => added += handleCommentNode(sub));
//         } else {
//           node.querySelectorAll?.("ytd-comment-view-model, ytd-comment-renderer")
//             .forEach(sub => added += handleCommentNode(sub));
//         }
//       }
//     }
//     if (added > 0) renderList();
//   });
//   obs.observe(document.documentElement, { childList: true, subtree: true });

//   // SPA 네비
//   let last = location.href;
//   const navObs = new MutationObserver(() => {
//     if (location.href !== last) {
//       last = location.href;
//       resetState();
//       log("페이지 전환 감지 → 초기화 및 재시작");
//       initWhenReady();
//     }
//   });
//   navObs.observe(document, { childList: true, subtree: true });

//   window.__ytTc_scan = () => { rescanAndRender(); };
// }

// function resetState() {
//   leadingItems.length = 0;
//   nonLeadingStore.clear();
//   seen.clear();
//   const list = byId("ytc-list"); if (list) list.innerHTML = "";
// }

function rescanAndRender() {
  const added = scanOnce();
  if (added > 0) renderList();
}

// /* -------------------------------
//    댓글 컨테이너 대기 (실험군/지연 로드 대응)
// -------------------------------- */
// function isWatchPage() { return location.pathname === "/watch"; }
// function findCommentsRoot() {
//   return (
//     document.querySelector("ytd-comments") ||
//     document.querySelector("#comments") ||
//     document.querySelector("ytd-item-section-renderer#sections") ||
//     document.querySelector("ytd-engagement-panel-section-list-renderer") ||
//     null
//   );
// }
// function forceLoadComments() {
//   const anchor =
//     document.querySelector("#comments") ||
//     document.querySelector("ytd-comments") ||
//     document.querySelector("ytd-item-section-renderer#sections") ||
//     document.querySelector("ytd-app");
//   anchor?.scrollIntoView?.({ behavior: "auto", block: "center" });
//   window.scrollBy(0, 120);
// }
// function waitForCommentsHost(cb, tries = 0) {
//   const root = findCommentsRoot();
//   if (root) return cb();

//   if (tries < 15) {
//     forceLoadComments();
//     return setTimeout(() => waitForCommentsHost(cb, tries + 1), 600);
//   }

//   let found = false;
//   const obs = new MutationObserver(() => {
//     const r = findCommentsRoot();
//     if (r) { found = true; obs.disconnect(); cb(); }
//   });
//   obs.observe(document.documentElement, { childList: true, subtree: true });

//   setTimeout(() => {
//     if (found) return;
//     obs.disconnect();
//     warn("댓글 컨테이너가 생성되지 않습니다. (Shorts/비활성/실험군 가능)");
//   }, 20000);
// }
// window.__ytTc_forceLoad = () => forceLoadComments();

// /* -------------------------------
//    초기 진입
// -------------------------------- */
// function initWhenReady() {
//   if (!isWatchPage()) {
//     warn("watch 페이지가 아닙니다(Shorts 등). 이 확장은 /watch 에서만 동작합니다.");
//     return;
//   }
//   log("초기화: 댓글 컨테이너 대기 후 스캔/패널 시작");
//   // ensureFab();
//   // ensurePanel();
//   waitForCommentsHost(() => startObservers());
// }

// initWhenReady();