// service-worker.js (MV3 Service Worker)
// 필요 권한: manifest.json 의 "scripting", "activeTab"

const DEBUG_LIMIT_STEPS = 200;     // 토큰 순회 상한 (무한루프 가드)
const BOOT_RETRY = 3;              // ytcfg/ytInitialData 재시도 횟수
const BOOT_DELAY_MS = 450;         // 재시도 간격
const WIDE_MODE = false;           // true면 댓글 토큰 필터 해제(진단용)

// 클라이언트 헤더 이중화 + /browse 폴백
const CLIENTS = {
  WEB:     { name: "1", versionHint: null },       // ytcfg의 clientVersion 사용
  ANDROID: { name: "3", versionHint: "19.39.34" }  // 안드 최신 근처 버전 힌트
};
const USE_BROWSE_FALLBACK = true;  // /next 실패 시 /browse 재시도

// 메시지 엔트리
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_COMMENTS" || msg?.type === "INNERTUBE_FETCH_ALL") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number") throw new Error("Tab ID unavailable.");

      // 1) 부팅(메인 월드에서 ytcfg/ytInitialData + entryToken)
      const boot = await getBoot(tabId);
      if (!boot?.apiKey || !boot?.clientVersion) throw new Error("ytcfg/ytInitialData 읽기 실패");

      safeSend(tabId, { type: "FETCH_STATUS", state: "start" });

      // 2) 큐/방문집합/결과 버퍼
      const comments = [];
      const visited = new Set();
      const queue = [];
      const videoId = msg.videoId || (sender?.url ? new URL(sender.url).searchParams.get("v") : null);

      // entryToken 우선, 없으면 videoId로 초기 next 1회
      if (boot.entryToken) {
        queue.push(boot.entryToken);
      } else {
        if (!videoId) throw new Error("videoId/entryToken 둘 다 없음");
        const init = await ytInnerTubeCall(tabId, boot, { context: boot.context, videoId }, { client: "WEB", useBrowse: false });
        extract(init, comments, queue);
        safeSend(tabId, { type: "FETCH_STATUS", phase: "init", tokens: queue.length, comments: comments.length });
      }

      // 3) continuation 루프 (+ 폴백 전략)
      let steps = 0;
      let zeroStreak = 0;

      while (queue.length && steps < DEBUG_LIMIT_STEPS) {
        steps++;
        const token = queue.shift();
        if (!token || visited.has(token)) continue;
        visited.add(token);

        const prevT = queue.length;
        const prevC = comments.length;

        const page = await callWithFallback(tabId, boot, token);
        extract(page, comments, queue);

        const dtT = queue.length - prevT;
        const dtC = comments.length - prevC;
        safeSend(tabId, { type: "FETCH_STATUS", phase: "step", tokens: dtT, comments: dtC });

        if (dtC === 0) zeroStreak++; else zeroStreak = 0;
        if (zeroStreak >= 10) {
          safeSend(tabId, { type: "FETCH_STATUS", state: "info", msg: "comments+=0 10회 연속; 필요시 WIDE_MODE=true 테스트 권장" });
          zeroStreak = 0;
        }
      }

      if (steps >= DEBUG_LIMIT_STEPS) {
        safeSend(tabId, { type: "FETCH_STATUS", state: "info", msg: "token loop guard reached" });
      }

      safeSend(tabId, { type: "FETCH_STATUS", state: "done", count: comments.length });
      sendResponse({ ok: true, data: comments });
    })().catch(err => {
      if (sender?.tab?.id) safeSend(sender.tab.id, { type: "FETCH_STATUS", state: "error", error: String(err) });
      sendResponse({ ok: false, error: String(err) });
    });
    return true; // async
  }
});

// ---------- Boot(ytcfg/initialData/entryToken) ----------
async function getBoot(tabId) {
  let delay = BOOT_DELAY_MS;
  for (let i = 0; i < BOOT_RETRY; i++) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const ytcfg = (window.ytcfg && typeof window.ytcfg.get === "function")
          ? { get: k => window.ytcfg.get(k) }
          : { get: k => (window.ytcfg?.data_ || {})[k] };

        const initialData = window.ytInitialData || {};

        function findCommentEntryToken(root) {
          let found = null;
          walk(root, (o) => {
            // A) 댓글 패널(engagement panel)
            if (o?.engagementPanelSectionListRenderer?.panelIdentifier === "engagement-panel-comments-section") {
              const items = o.engagementPanelSectionListRenderer?.content?.sectionListRenderer?.contents;
              if (Array.isArray(items)) {
                for (const it of items) {
                  found ||= it?.itemSectionRenderer?.contents?.[0]
                    ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                }
              }
            }
            // B) entry-point
            if (o?.itemSectionRenderer?.sectionIdentifier === "comments-entry-point") {
              found ||= o?.itemSectionRenderer?.contents?.[0]
                ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
            }
            // C) onResponseReceived 계열
            const rci = o?.reloadContinuationItemsCommand?.continuationItems;
            if (Array.isArray(rci)) {
              for (const it of rci) {
                found ||= it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
              }
            }
            const aci = o?.appendContinuationItemsAction?.continuationItems;
            if (Array.isArray(aci)) {
              for (const it of aci) {
                found ||= it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
              }
            }
          });
          return found;

          function walk(x, fn) {
            if (!x || typeof x !== "object") return;
            fn(x);
            for (const v of Object.values(x)) walk(v, fn);
          }
        }

        return {
          apiKey:        ytcfg.get("INNERTUBE_API_KEY"),
          clientVersion: ytcfg.get("INNERTUBE_CLIENT_VERSION"),
          visitorData:   ytcfg.get("VISITOR_DATA"),
          context:       ytcfg.get("INNERTUBE_CONTEXT") || {
            client: { clientName: "WEB", clientVersion: ytcfg.get("INNERTUBE_CLIENT_VERSION"), hl: "ko", gl: "KR" }
          },
          entryToken:    findCommentEntryToken(initialData)
        };
      }
    });

    // 부트 로깅(진단)
    try {
      console.log("[SW] ytcfg", {
        apiKey: !!result?.apiKey,
        clientVersion: result?.clientVersion,
        hasCtx: !!result?.context,
        visitorData: !!result?.visitorData,
        hasInitialToken: !!result?.entryToken
      });
    } catch {}

    if (result?.apiKey && result?.clientVersion) return result;
    await sleep(delay);
    delay = Math.min(delay * 1.6, 1500);
  }
  throw new Error("ytcfg/ytInitialData not ready");
}

// ---------- InnerTube 호출(메인 월드 fetch) ----------
async function ytInnerTubeCall(tabId, boot, payload, opts = {}) {
  // opts: { client: "WEB" | "ANDROID", useBrowse: boolean }
  const clientKey = opts.client || "WEB";
  const useBrowse = !!opts.useBrowse;
  const path = useBrowse ? "/youtubei/v1/browse" : "/youtubei/v1/next";

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (apiKey, webClientVersion, visitorData, path, body, clientName, versionHint) => {
      const headers = {
        "Content-Type": "application/json",
        "x-goog-api-format-version": "2",
        "X-YouTube-Client-Name": clientName,  // "1"=WEB, "3"=ANDROID
        "X-YouTube-Client-Version":
          clientName === "1" ? (webClientVersion || "2.2025.01.01.00") : (versionHint || "19.39.34")
      };
      if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;

      const url = `https://www.youtube.com${path}?key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        credentials: "include"  // 연령/지역 제한 쿠키 동반
      });
      if (!res.ok) return { ok:false, status: res.status, text: await res.text() };
      return { ok:true, json: await res.json() };
    },
    args: [
      boot.apiKey,
      boot.clientVersion,
      boot.visitorData || null,
      path,
      // ANDROID 컨텍스트일 때는 context 스위치
      clientKey === "ANDROID"
        ? { ...payload, context: androidContext(boot.context) }
        : payload,
      CLIENTS[clientKey].name,
      CLIENTS[clientKey].versionHint
    ]
  });

  if (!result?.ok) throw new Error(`HTTP ${result?.status}: ${result?.text}`);
  return result.json;
}

// /next 실패 시 ANDROID 및 /browse 폴백
async function callWithFallback(tabId, boot, continuationToken) {
  // 1차: WEB + /next
  try {
    return await ytInnerTubeCall(tabId, boot, { context: boot.context, continuation: continuationToken }, { client: "WEB", useBrowse: false });
  } catch (e1) {
    // 2차: ANDROID + /next
    try {
      return await ytInnerTubeCall(tabId, boot, { context: boot.context, continuation: continuationToken }, { client: "ANDROID", useBrowse: false });
    } catch (e2) {
      if (!USE_BROWSE_FALLBACK) throw e2;
      // 3차: WEB + /browse
      try {
        return await ytInnerTubeCall(tabId, boot, { context: boot.context, continuation: continuationToken }, { client: "WEB", useBrowse: true });
      } catch (e3) {
        // 4차: ANDROID + /browse
        return await ytInnerTubeCall(tabId, boot, { context: boot.context, continuation: continuationToken }, { client: "ANDROID", useBrowse: true });
      }
    }
  }
}

function androidContext(ctx) {
  const out = JSON.parse(JSON.stringify(ctx || {}));
  out.client = out.client || {};
  out.client.clientName = "ANDROID";
  out.client.clientVersion = CLIENTS.ANDROID.versionHint || "19.39.34";
  // locale 유지
  out.client.hl = out.client.hl || "ko";
  out.client.gl = out.client.gl || "KR";
  delete out.client.clientScreen;
  return out;
}

// ---------- 추출기 ----------
function extract(json, sink, queue) {
  let foundAny = false;

  walk(json, (o) => {
    // 최상위 스레드
    if (o?.commentThreadRenderer?.comment?.commentRenderer) {
      pushComment(sink, o.commentThreadRenderer.comment.commentRenderer, true);
      foundAny = true;

      // 답글 더보기 토큰
      const repTok = o?.commentThreadRenderer?.replies?.commentRepliesRenderer
        ?.continuations?.[0]?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (repTok) queue.push(repTok);
    }

    // 개별 댓글(답글)
    if (o?.commentRenderer?.commentId && o?.commentRenderer?.contentText) {
      pushComment(sink, o.commentRenderer, false);
      foundAny = true;
    }

    // onResponseReceived targetId 기반
    const tgtA = o?.reloadContinuationItemsCommand?.targetId;
    if (typeof tgtA === "string" && tgtA.includes("comment")) {
      for (const it of (o.reloadContinuationItemsCommand?.continuationItems || [])) {
        const t = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (t) queue.push(t);
      }
    }
    const tgtB = o?.appendContinuationItemsAction?.targetId;
    if (typeof tgtB === "string" && tgtB.includes("comment")) {
      for (const it of (o.appendContinuationItemsAction?.continuationItems || [])) {
        const t = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (t) queue.push(t);
      }
    }

    // 일반 continuation — 댓글 섹션 주변만
    const cont = o?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
              || o?.nextContinuationData?.continuation;
    if (cont && (WIDE_MODE || looksLikeCommentPath(o))) queue.push(cont);

    // 헤더만 먼저 오는 실험 케이스
    if (o?.commentsHeaderRenderer) foundAny = true;
  });

  // 첫 페이지에서 전혀 못 찾았을 때 형상 확인용(선택)
  if (!foundAny && typeof json === "object") {
    try { console.log("[SW] page top keys:", Object.keys(json).slice(0, 10)); } catch {}
  }
}

function pushComment(sink, cr, isTopLevel) {
  const text = textOf(cr?.contentText);
  if (typeof text === "string") {
    sink.push({
      id: cr?.commentId,
      text,
      isTopLevel: !!isTopLevel
    });
  }
}

function looksLikeCommentPath(node) {
  if (!node || typeof node !== "object") return false;
  if (node?.engagementPanelSectionListRenderer?.panelIdentifier === "engagement-panel-comments-section") return true;
  if (node?.itemSectionRenderer?.sectionIdentifier === "comments-entry-point") return true;
  if (node?.commentRepliesRenderer || node?.commentThreadRenderer) return true;
  if (typeof node?.reloadContinuationItemsCommand?.targetId === "string"
      && node.reloadContinuationItemsCommand.targetId.includes("comment")) return true;
  if (typeof node?.appendContinuationItemsAction?.targetId === "string"
      && node.appendContinuationItemsAction.targetId.includes("comment")) return true;
  return false;
}

function textOf(contentText) {
  if (!contentText) return "";
  if (Array.isArray(contentText.runs)) return contentText.runs.map(r => r?.text ?? "").join("");
  if (typeof contentText.simpleText === "string") return contentText.simpleText;
  return "";
}

function walk(x, fn) {
  if (!x || typeof x !== "object") return;
  fn(x);
  for (const v of Object.values(x)) walk(v, fn);
}

function safeSend(tabId, payload) {
  if (typeof tabId !== "number") return;
  try { chrome.tabs.sendMessage(tabId, payload); } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
