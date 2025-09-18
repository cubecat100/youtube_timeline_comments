// Innertube ONLY — 가능한 한 많은 댓글 "텍스트 배열"을 수집해 전달
(function () {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------- text helpers ----------
    const emojiToStr = (em) =>
        (em?.shortcuts && em.shortcuts[0]) ||
        em?.altText ||
        em?.image?.accessibility?.accessibilityData?.label ||
        "";

    const runsToStr = (runs) =>
        Array.isArray(runs)
            ? runs.map(r => typeof r?.text === "string" ? r.text : (r?.emoji ? emojiToStr(r.emoji) : "")).join("")
            : "";

    function discoverCommentText(node) {
        if (typeof node === "string") return node.trim();
        const elsToStr = (els) =>
            Array.isArray(els)
                ? els.map(el =>
                    el?.textRun ? (el.textRun.content || "") :
                        el?.emojiRun ? emojiToStr(el.emojiRun.emoji) : ""
                ).join("")
                : "";
        let best = "";
        const push = (s) => { const t = (s || "").trim(); if (t.length > best.length) best = t; };

        const q = [node], seen = new Set();
        while (q.length) {
            const cur = q.shift();
            if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
            seen.add(cur);

            if (Array.isArray(cur)) { for (const x of cur) q.push(x); continue; }
            if (typeof cur.simpleText === "string") push(cur.simpleText);
            if (Array.isArray(cur.runs)) push(runsToStr(cur.runs));
            if (cur.document?.elements) push(elsToStr(cur.document.elements));
            if (cur.content?.document?.elements) push(elsToStr(cur.content.document.elements));

            const keys = ["expandedContentText", "originalText", "contentText", "attributedText", "content", "value", "document", "text"];
            for (const k of keys) if (cur[k] != null) q.push(cur[k]);

            const a11y = cur.accessibility?.accessibilityData?.label;
            if (a11y) push(a11y);

            for (const v of Object.values(cur)) if (v && typeof v === "object") q.push(v);
        }
        return best;
    }

    const safeText = (x) => {
        if (x == null) return "";
        if (typeof x === "string" || typeof x === "number") return String(x).trim();
        if (x.simpleText) return String(x.simpleText).trim();
        if (Array.isArray(x.runs)) return runsToStr(x.runs).trim();
        return discoverCommentText(x);
    };

    // ---------- parsers ----------
    function fromCommentRenderer(cr, parentId = null) {
        if (!cr) return null;
        return {
            id: cr.commentId,
            parentId,
            text: discoverCommentText(cr),
            author: safeText(cr.authorText)
        };
    }
    function fromThreadRenderer(tr) {
        const out = [];
        const top = tr?.comment?.commentRenderer;
        const topItem = fromCommentRenderer(top, null);
        if (topItem) out.push(topItem);
        const replies = tr?.replies?.commentRepliesRenderer?.contents || [];
        for (const c of replies) {
            const r = c?.commentRenderer;
            const item = fromCommentRenderer(r, topItem?.id ?? null);
            if (item) out.push(item);
        }
        return out;
    }
    function fromCommentEntity(ce, parentId = null) {
        if (!ce) return null;
        return {
            id: ce.commentId || ce.key || ce.id || null,
            parentId: parentId || ce?.commentParentId || null,
            text: discoverCommentText(ce),
            author: safeText(ce.author?.name || ce.authorText || "")
        };
    }
    function fromCommentViewModel(cvm, parentId = null) {
        if (!cvm) return null;
        const id = cvm?.commentId || cvm?.id || null;
        if (!id) return null;
        return {
            id, parentId,
            text: discoverCommentText(cvm),
            author: safeText(cvm?.authorText || cvm?.author?.name || "")
        };
    }
    // frameworkUpdates.entityBatchUpdate.mutations[].payload.commentEntityPayload
    function fromCommentEntityPayload(cep, parentId = null) {
        if (!cep) return null;
        const props = cep.properties || cep;
        const id = props.commentId || cep.commentId || props.key || cep.key || null;
        let text = "";
        if (typeof props?.content?.content === "string") text = props.content.content;
        else text = discoverCommentText(props.content || props);
        return { id, parentId: props.commentParentId || parentId || null, text, author: "" };
    }

    function walkForComments(json, out) {
        (function walk(n) {
            if (!n || typeof n !== "object") return;

            if (n.commentThreadRenderer) out.push(...fromThreadRenderer(n.commentThreadRenderer));
            else if (n.commentRenderer) {
                const it = fromCommentRenderer(n.commentRenderer, n.commentRenderer?.commentTargetId ?? null);
                if (it) out.push(it);
            } else if (n.commentViewModel) {
                const it = fromCommentViewModel(n.commentViewModel, n.commentViewModel?.commentTargetId ?? null);
                if (it) out.push(it);
            }

            if (n.payload?.commentEntity) {
                const it = fromCommentEntity(n.payload.commentEntity, n.payload?.commentEntity?.commentTargetId ?? null);
                if (it) out.push(it);
            }
            if (n.payload?.commentEntityPayload) {
                const it = fromCommentEntityPayload(
                    n.payload.commentEntityPayload,
                    n.payload?.commentEntityPayload?.properties?.commentTargetId ??
                    n.payload?.commentEntityPayload?.properties?.commentParentId ?? null
                );
                if (it) out.push(it);
            }

            const muts = n.frameworkUpdates?.entityBatchUpdate?.mutations;
            if (Array.isArray(muts)) {
                for (const m of muts) {
                    const p = m?.payload || {};
                    if (p.commentEntityPayload) {
                        const it = fromCommentEntityPayload(p.commentEntityPayload, p.commentEntityPayload?.properties?.commentParentId || null);
                        if (it) out.push(it);
                    }
                    if (p.commentEntity) {
                        const it = fromCommentEntity(p.commentEntity, p.commentEntity?.commentParentId || null);
                        if (it) out.push(it);
                    }
                }
            }

            for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
        })(json);
    }

    function hasCommentPayload(json) {
        let found = false;
        (function walk(n) {
            if (!n || typeof n !== "object" || found) return;
            if (n.commentThreadRenderer || n.commentRenderer || n.commentViewModel ||
                n?.payload?.commentEntity || n?.payload?.commentEntityPayload ||
                n.frameworkUpdates?.entityBatchUpdate?.mutations) { found = true; return; }
            for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
        })(json);
        return found;
    }

    // ---------- entry helpers ----------
    const isCommentsTargetId = (id) => {
        if (!id || typeof id !== "string") return false;
        const s = id.toLowerCase();
        return s.includes("comments-section") || s.includes("comment_section") || s.includes("engagement-panel-comments-section");
    };

    function pickEntryTokensFromWatchJson(json) {
        if (!json || typeof json !== "object") return [];
        const uniq = new Set();
        const scanItemSection = (root) => {
            const results = root?.results?.results?.contents || [];
            for (const c of results) {
                const sec = c?.itemSectionRenderer;
                if (!sec) continue;
                const header = sec.header?.commentsEntryPointHeaderRenderer || sec.header?.itemSectionHeaderRenderer;
                const isCommentSection = !!header || sec.sectionIdentifier === "comment_section";
                if (!isCommentSection) continue;
                for (const it of (sec.contents || [])) {
                    const tok = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                    if (typeof tok === "string" && tok.length > 10) uniq.add(tok);
                }
            }
        };
        try {
            if (json.contents?.twoColumnWatchNextResults) {
                scanItemSection(json.contents.twoColumnWatchNextResults);
                const panels = json.contents.twoColumnWatchNextResults.engagementPanels || [];
                for (const p of panels) {
                    const pl = p?.engagementPanelSectionListRenderer;
                    if (!pl) continue;
                    const id = pl.panelIdentifier || pl.identifier || "";
                    if (!isCommentsTargetId(id)) continue;
                    const conts = pl?.content?.sectionListRenderer?.contents || [];
                    for (const it of conts) {
                        const tok = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                        if (typeof tok === "string" && tok.length > 10) uniq.add(tok);
                    }
                }
            }
            if (json.contents?.singleColumnWatchNextResults) scanItemSection(json.contents.singleColumnWatchNextResults);
            const endp = json.onResponseReceivedEndpoints || [];
            for (const e of endp) {
                const items = e?.appendContinuationItemsAction?.continuationItems || e?.reloadContinuationItemsCommand?.continuationItems || [];
                for (const it of items) {
                    const tok = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                    if (typeof tok === "string" && tok.length > 10) uniq.add(tok);
                }
            }
        } catch { }
        return Array.from(uniq);
    }

    function pickEntryParamsFromWatchJson(json) {
        if (!json || typeof json !== "object") return [];
        const out = new Set();
        (function walk(n, path) {
            if (!n || typeof n !== "object") return;
            const pth = (path || "").toLowerCase();
            const id = n.panelIdentifier || n.identifier || n.targetId || "";
            if (isCommentsTargetId(id) && typeof n.params === "string" && n.params.length > 10) out.add(n.params);
            if (typeof n.params === "string" && n.params.length > 10 && (pth.includes("comment") || pth.includes("engagement"))) out.add(n.params);
            for (const [k, v] of Object.entries(n)) if (v && typeof v === "object") walk(v, (path ? path + "." : "") + k);
        })(json, "");
        return Array.from(out);
    }

    // 느슨한 토큰 스캐너: 어디에 있든 continuation을 다 주워온다 (댓글/대댓글 포함)
    function collectAnyContinuations(root) {
        const seen = new Set(), out = [];
        (function walk(n) {
            if (!n || typeof n !== "object") return;
            const t1 = n?.continuationEndpoint?.continuationCommand?.token;
            const t2 = n?.nextContinuationData?.continuation || n?.reloadContinuationData?.continuation;
            if (typeof t1 === "string" && t1.length > 10 && !seen.has(t1)) { seen.add(t1); out.push(t1); }
            if (typeof t2 === "string" && t2.length > 10 && !seen.has(t2)) { seen.add(t2); out.push(t2); }
            for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
        })(root);
        return out;
    }

    // 댓글 타깃에 한정한 스캐너(보조)
    function collectCommentContinuationsOnly(root) {
        const seen = new Set(), hi = [];
        (function walk(n, path) {
            if (!n || typeof n !== "object") return;

            const rcd = n.reloadContinuationItemsCommand;
            if (rcd?.continuationItems) {
                const tid = rcd.targetId || "";
                if (isCommentsTargetId(tid)) {
                    for (const it of rcd.continuationItems) {
                        const t = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                        if (t && t.length > 10 && !seen.has(t)) { seen.add(t); hi.push(t); }
                    }
                }
            }

            const ncd = n.nextContinuationData || n.reloadContinuationData;
            if (ncd?.continuation) {
                const p = (path || "").toLowerCase();
                if (p.includes("comment")) {
                    const t = ncd.continuation;
                    if (t && t.length > 10 && !seen.has(t)) { seen.add(t); hi.push(t); }
                }
            }

            const ce = n.continuationEndpoint?.continuationCommand?.token;
            if (ce) {
                const tid = n.continuationEndpoint?.targetId || "";
                if (isCommentsTargetId(tid) && ce.length > 10 && !seen.has(ce)) { seen.add(ce); hi.push(ce); }
            }

            for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, (path ? path + "." : "") + "x");
        })(root, "");
        return hi;
    }

    // ---------- hooks / keyctx ----------
    function hookOutgoing(onHit) {
        const _fetch = window.fetch;
        window.fetch = async function (input, init) {
            try {
                const url = typeof input === "string" ? input : (input && input.url) || "";
                if (typeof url === "string" && url.includes("/youtubei/v1/")) {
                    let key = ""; try { key = new URL(url).searchParams.get("key") || ""; } catch { }
                    let bodyText = "";
                    try {
                        if (init?.body && typeof init.body === "string") bodyText = init.body;
                        else if (input instanceof Request) bodyText = await input.clone().text();
                    } catch { }
                    onHit({ url, key, bodyText });
                }
            } catch { }
            return _fetch.apply(this, arguments);
        };
        const _open = XMLHttpRequest.prototype.open;
        const _send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__yt_url = url; return _open.call(this, method, url, ...rest); };
        XMLHttpRequest.prototype.send = function (body) {
            try {
                const url = this.__yt_url || "";
                if (typeof url === "string" && url.includes("/youtubei/v1/")) {
                    let key = ""; try { key = new URL(url).searchParams.get("key") || ""; } catch { }
                    const bodyText = typeof body === "string" ? body : "";
                    onHit({ url, key, bodyText });
                }
            } catch { }
            return _send.apply(this, arguments);
        };
        return function unhook() { window.fetch = _fetch; XMLHttpRequest.prototype.open = _open; XMLHttpRequest.prototype.send = _send; };
    }

    async function getKeyContextWithFallback() {
        const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
            const cfg = (window.ytcfg && typeof window.ytcfg.get === "function") ? window.ytcfg : null;
            if (cfg) {
                const key = cfg.get("INNERTUBE_API_KEY") || cfg.get("INNERTUBE_API_KEYV2") || null;
                const ctx = cfg.get("INNERTUBE_CONTEXT") || null;
                const visitor = cfg.get("VISITOR_DATA") || (ctx?.client?.visitorData ?? null) || null;
                if (key && ctx) return { key, ctx, visitor };
            }
            await sleep(50);
        }
        let resolved = null;
        const unhook = hookOutgoing(({ key, bodyText }) => {
            if (!key) return;
            try {
                const body = bodyText && JSON.parse(bodyText);
                const ctx = body?.context;
                if (ctx) resolved = { key, ctx, visitor: ctx?.client?.visitorData || null };
            } catch { }
        });
        const comments = document.querySelector("#comments");
        if (comments) { comments.scrollIntoView({ behavior: "auto", block: "center" }); await sleep(200); }
        const w0 = performance.now();
        while (!resolved && performance.now() - w0 < 2500) await sleep(80);
        unhook();
        if (resolved) return resolved;
        throw new Error("INNERTUBE key/context not found");
    }

    function getVideoId() {
        try { const v = new URL(location.href).searchParams.get("v"); if (v) return v; } catch { }
        try { const v = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id"); if (v) return v; } catch { }
        try { const v = (window.ytcfg && typeof ytcfg.get === "function" && ytcfg.get("PLAYER_VARS")?.video_id) || null; if (v) return v; } catch { }
        try { const v = window.ytInitialPlayerResponse?.videoDetails?.videoId; if (v) return v; } catch { }
        return null;
    }

    // ---------- Innertube calls ----------
    async function callNext({ key, ctx, visitor, continuation }) {
        if (!ctx?.client?.originalUrl) ctx = { ...ctx, client: { ...ctx.client, originalUrl: location.href } };
        const url = "https://www.youtube.com/youtubei/v1/next?key=" + encodeURIComponent(key);
        const headers = {
            "content-type": "application/json",
            "x-youtube-client-name": "1",
            "x-youtube-client-version": String(ctx?.client?.clientVersion || "2.20240731.00.00"),
        };
        if (visitor) headers["x-goog-visitor-id"] = visitor;
        const body = JSON.stringify({ context: ctx, continuation });
        const res = await fetch(url, { method: "POST", headers, body, credentials: "include" });
        if (!res.ok) throw new Error(`next ${res.status}`);
        return res.json();
    }
    async function callNextByVideoId({ key, ctx, visitor, videoId }) {
        if (!ctx?.client?.originalUrl) ctx = { ...ctx, client: { ...ctx.client, originalUrl: location.href } };
        const url = "https://www.youtube.com/youtubei/v1/next?key=" + encodeURIComponent(key);
        const headers = {
            "content-type": "application/json",
            "x-youtube-client-name": "1",
            "x-youtube-client-version": String(ctx?.client?.clientVersion || "2.20240731.00.00"),
        };
        if (visitor) headers["x-goog-visitor-id"] = visitor;
        const body = JSON.stringify({ context: ctx, videoId });
        const res = await fetch(url, { method: "POST", headers, body, credentials: "include" });
        if (!res.ok) throw new Error(`next(videoId) ${res.status}`);
        return res.json();
    }
    async function callNextByParams({ key, ctx, visitor, params }) {
        if (!ctx?.client?.originalUrl) ctx = { ...ctx, client: { ...ctx.client, originalUrl: location.href } };
        const url = "https://www.youtube.com/youtubei/v1/next?key=" + encodeURIComponent(key);
        const headers = {
            "content-type": "application/json",
            "x-youtube-client-name": "1",
            "x-youtube-client-version": String(ctx?.client?.clientVersion || "2.20240731.00.00"),
        };
        if (visitor) headers["x-goog-visitor-id"] = visitor;
        const body = JSON.stringify({ context: ctx, params });
        const res = await fetch(url, { method: "POST", headers, body, credentials: "include" });
        if (!res.ok) throw new Error(`next(params) ${res.status}`);
        return res.json();
    }

    // ---------- drain (options supported) ----------
    async function drainTokens(initialTokens, keyctx, opts = {}) {
        const {
            maxComments = Infinity,
            hardStopMs = 10 * 60 * 1000,
            maxIdleMs = 6000,
            throttleMs = 120
        } = opts;

        const hiQ = Array.from(new Set(initialTokens));
        const seenTok = new Set(hiQ);
        const map = new Map();
        const startedAt = performance.now();
        let lastProgressAt = performance.now();

        while (hiQ.length) {
            if (performance.now() - startedAt > hardStopMs) break;

            const tk = hiQ.shift();
            let json; try { json = await callNext({ ...keyctx, continuation: tk }); } catch { continue; }

            // 댓글 페이로드가 없는 응답은 스킵(여유를 두되 과대대기 방지)
            if (!hasCommentPayload(json)) {
                if (performance.now() - lastProgressAt > maxIdleMs && hiQ.length === 0) break;
                await sleep(throttleMs);
                continue;
            }

            // 파싱
            const buf = [];
            walkForComments(json, buf);

            // 병합
            let touched = 0;
            for (const it of buf) {
                if (!it?.id) continue;
                const prev = map.get(it.id);
                if (!prev) {
                    map.set(it.id, it);
                    touched++;
                } else {
                    if ((it.text || "").length > (prev.text || "").length) { prev.text = it.text; touched++; }
                    if (!prev.author && it.author) { prev.author = it.author; touched++; }
                }
            }
            if (map.size >= maxComments) break;

            // 다음 토큰 (느슨 + 댓글전용 둘 다)
            const nexts = [
                ...collectAnyContinuations(json),
                ...collectCommentContinuationsOnly(json)
            ];
            for (const nt of nexts) if (!seenTok.has(nt)) { seenTok.add(nt); hiQ.push(nt); }

            if (touched > 0 || nexts.length > 0) lastProgressAt = performance.now();

            if (hiQ.length === 0 && performance.now() - lastProgressAt > maxIdleMs) break;
            await sleep(throttleMs);
        }

        // 텍스트 배열만 반환
        return Array.from(map.values())
            .map(c => (c.text || "").trim())
            .filter(Boolean);
    }

    // ---------- bootstrap ----------
    window.postMessage({ type: "YTCC_READY" }, "*");

    window.addEventListener("message", async (ev) => {
        if (ev.source !== window || !ev.data) return;
        if (ev.data.type !== "YTCC_START") return;

        const evOpts = ev.data.opts || {};

        try {
            const keyctx = await getKeyContextWithFallback();

            // 1) 초기 진입점(ytInitialData → videoId → intercept)
            const entry = await (async function getInitialEntry() {
                const t0 = pickEntryTokensFromWatchJson(window.ytInitialData);
                if (t0.length > 0) return { kind: "tokens", values: t0 };
                const p0 = pickEntryParamsFromWatchJson(window.ytInitialData);
                if (p0.length > 0) return { kind: "params", values: p0 };

                const vid = getVideoId();
                if (vid) {
                    try {
                        const j = await callNextByVideoId({ ...keyctx, videoId: vid });
                        const t1 = pickEntryTokensFromWatchJson(j);
                        if (t1.length > 0) return { kind: "tokens", values: t1 };
                        const p1 = pickEntryParamsFromWatchJson(j);
                        if (p1.length > 0) return { kind: "params", values: p1 };
                    } catch { }
                }

                // 인터셉트로 continuation/params 캐치
                const foundTok = new Set(), foundPar = new Set();
                const unhook = hookOutgoing(({ bodyText }) => {
                    try {
                        const b = bodyText && JSON.parse(bodyText);
                        if (typeof b?.continuation === "string" && b.continuation.length > 10) foundTok.add(b.continuation);
                        if (typeof b?.params === "string" && b.params.length > 10) foundPar.add(b.params);
                    } catch { }
                });
                const comments = document.querySelector("#comments");
                if (comments) { comments.scrollIntoView({ behavior: "auto", block: "center" }); await sleep(200); }
                const w0 = performance.now();
                while (foundTok.size === 0 && foundPar.size === 0 && performance.now() - w0 < 2500) await sleep(80);
                unhook();

                if (foundTok.size > 0) return { kind: "tokens", values: Array.from(foundTok) };
                if (foundPar.size > 0) return { kind: "params", values: Array.from(foundPar) };
                throw new Error("No initial comment continuation token/params");
            })();

            // 2) tokens이면 바로 드레인, params면 첫 응답 직파싱 + 느슨한 토큰 폴백 (+forceDrain)
            let initialTokens = [];
            if (entry.kind === "tokens") {
                initialTokens = entry.values;
            } else {
                for (const p of entry.values) {
                    try {
                        const j = await callNextByParams({ ...keyctx, params: p });

                        if (hasCommentPayload(j)) {
                            if (evOpts.forceDrain) {
                                const seeds = [...collectAnyContinuations(j), ...collectCommentContinuationsOnly(j)];
                                if (seeds.length) { initialTokens = Array.from(new Set(seeds)); break; }
                            }
                            const buf = []; walkForComments(j, buf);
                            const texts = buf.map(c => (c.text || "").trim()).filter(Boolean);
                            if (texts.length && !evOpts.forceDrain) { window.postMessage({ type: "YTCC_TEXTS_ONLY", payload: texts }, "*"); return; }
                            const any = collectAnyContinuations(j);
                            if (any.length) { initialTokens = any; break; }
                        }

                        const toks = collectCommentContinuationsOnly(j);
                        if (toks.length > 0) { initialTokens = toks; break; }
                    } catch { }
                }

                if (!initialTokens.length) {
                    try {
                        const vid = getVideoId();
                        if (vid) {
                            const j2 = await callNextByVideoId({ ...keyctx, videoId: vid });

                            if (hasCommentPayload(j2)) {
                                if (evOpts.forceDrain) {
                                    const seeds2 = [...collectAnyContinuations(j2), ...collectCommentContinuationsOnly(j2)];
                                    if (seeds2.length) initialTokens = Array.from(new Set(seeds2));
                                } else {
                                    const buf2 = []; walkForComments(j2, buf2);
                                    const texts2 = buf2.map(c => (c.text || "").trim()).filter(Boolean);
                                    if (texts2.length) { window.postMessage({ type: "YTCC_TEXTS_ONLY", payload: texts2 }, "*"); return; }
                                }
                            }

                            if (!initialTokens.length) {
                                const any2 = collectAnyContinuations(j2);
                                if (any2.length) initialTokens = any2;
                                else {
                                    const toks2 = pickEntryTokensFromWatchJson(j2);
                                    if (toks2.length) initialTokens = toks2;
                                }
                            }
                        }
                    } catch { }
                }

                if (!initialTokens.length) {
                    throw new Error("No initial comment continuation token (params/videoId fallbacks exhausted)");
                }
            }

            // 3) 드레인(옵션 적용) → 텍스트 배열 전송
            const texts = await drainTokens(initialTokens, keyctx, evOpts);
            window.postMessage({ type: "YTCC_TEXTS_ONLY", payload: texts }, "*");

        } catch (e) {
            window.postMessage({ type: "YTCC_ERROR", payload: String(e?.message || e) }, "*");
        }
    });
})();
