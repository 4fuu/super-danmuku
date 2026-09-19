// AI danmaku quality filter powered by Jev (TypeSafe System One).
//
// Pipeline position: after pakku's combine + post_combine, before egress.
// Per time window (default 30s), merged clusters become candidates; one Jev
// request per window batch asks two questions per candidate in parallel:
//   - worst-framing Noul: "is this unrelated spam?"  (experiment winner for deletion)
//   - quality Score on 4 levels                        (for the elimination-ratio ranking)
// Absolute deletion: p_worst >= AI_DELETE_THRESHOLD -> drop.
// Ratio layer: among survivors, drop the worst floor(n * AI_RATIO) by score.
// All statistics (merge count, time span) are computed in code, never by the model.
// Every failure mode is fail-open: on any error the chunk passes through unchanged.

import {DanmuChunk, DanmuObjectRepresentative, int, LocalizedConfig} from "./types";

export interface VideoCtx {
    title?: string;
    uploader?: string;
    keywords?: string[];
    desc?: string;
}

let video_ctx: VideoCtx = {};

export function set_video_ctx(ctx: VideoCtx) {
    video_ctx = ctx;
}

export function get_video_ctx(): VideoCtx {
    return video_ctx;
}

// candidate: one merged cluster inside a window
interface Candidate {
    obj: DanmuObjectRepresentative;
    idx: int; // position in chunk.objs
    count: int; // merged peer count
    span_ms: int; // temporal span of the cluster inside this window
}

// semantic window: ratio-ranking scope, exemption unit and verdict-cache key
interface JudgedWindow {
    w: int;
    lo_s: int;
    hi_s: int;
    cands: Candidate[]; // count-desc: spam signature first
}

// request pack: adjacent judged windows sharing one Jev request
interface RequestPack {
    lo_s: int;
    hi_s: int;
    count: int; // candidates packed so far
    entries: {win: JudgedWindow, part: Candidate[]}[];
}

// per-video cache: window key -> array of {p_worst, score} aligned with candidate order
const ai_cache = new Map<string, Map<string, {p_worst: number, score: number, text: string}[]>>();
let cache_video_key = '';

function get_window_cache(video_key: string): Map<string, {p_worst: number, score: number, text: string}[]> {
    if(cache_video_key!==video_key) {
        ai_cache.clear();
        cache_video_key = video_key;
    }
    let m = ai_cache.get(video_key);
    if(!m) {
        m = new Map();
        ai_cache.set(video_key, m);
    }
    return m;
}

function hash_str(s: string): string {
    // djb2, good enough for a cache key
    let h = 5381;
    for(let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function call_jev(body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage({type: 'jev_call', body}, (resp: any) => {
                if(chrome.runtime.lastError)
                    return reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
                if(!resp || resp.error) {
                    // rate-limited / overloaded: callers retry with exponential backoff
                    if(resp && resp.retryable)
                        return reject(new RetryableError(resp.retry_after_ms || 0));
                    return reject(new Error((resp && resp.error) || 'jev_call failed'));
                }
                resolve(resp.data);
            });
        } catch(e) {
            reject(e as Error);
        }
    });
}

class RetryableError extends Error {
    constructor(public retry_after_ms: int) {
        super('retryable (rate limited)');
    }
}

const sleep_ms = (ms: int) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- proactive client-side rate limiting ----
// official quota: 250k tokens/s, 1200 requests/min (20 req/s). A burst at high
// concurrency trips 429s, and the resulting exponential backoff stalls far more
// than pacing ever costs, so request starts are smoothed well under the quota
// (token bucket). The 429 backoff below stays as a fallback for when the server
// still disagrees.
const AI_RATE_PER_S = 15; // request starts per second (75% of the official 20/s)
const AI_RATE_BURST = 4;  // bucket capacity: a tiny burst, then one start per 1/rate
let rl_tokens = AI_RATE_BURST;
let rl_last_refill = Date.now();
async function rl_acquire(): Promise<void> {
    while(true) {
        let now = Date.now();
        rl_tokens = Math.min(AI_RATE_BURST, rl_tokens + (now - rl_last_refill) * AI_RATE_PER_S / 1000);
        rl_last_refill = now;
        if(rl_tokens >= 1) {
            rl_tokens -= 1;
            return;
        }
        await sleep_ms(Math.ceil((1 - rl_tokens) * 1000 / AI_RATE_PER_S));
    }
}

const AI_RETRIES = 5; // exponential backoff: 500ms * 2^n, at least Retry-After when given
const AI_RETRY_BASE_MS = 500;

// ---- semantic window & request packing ----
// the window (5s) is only a semantic unit now: ratio-ranking scope, tiny-window
// exemption and the verdict-cache key. Requests no longer map 1:1 to windows:
// adjacent judged windows are packed into one request while the request stays
// small (<= AI_MAX_CANDIDATES candidates) and temporally tight (<= PACK_SPAN_S),
// so sparse videos stop paying one request per half-empty window
const SEMANTIC_WINDOW_S = 5;
const SEMANTIC_WINDOW_MS = SEMANTIC_WINDOW_S * 1000;
const PACK_SPAN_S = 90; // hard cap on one request's subtitle time range

function with_timeout<T>(p: Promise<T>, ms: int, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        let done = false;
        let timer = setTimeout(() => {
            if(!done) {
                done = true;
                resolve(fallback);
            }
        }, ms);
        p.then((v) => {
            if(!done) {
                done = true;
                clearTimeout(timer);
                resolve(v);
            }
        }).catch(() => {
            if(!done) {
                done = true;
                clearTimeout(timer);
                resolve(fallback);
            }
        });
    });
}

const WORST_CRITERIA = {
    true: 'Spam for this window: flooding or begging hoping to be picked for any giveaway, lottery or reward (regardless of exact wording) when the video is NOT currently discussing that giveaway in this time window; pure repeated characters with no meaning; utterances that by themselves carry no meaning or information no matter the topic — mood interjections, acknowledgement noises, isolated function-word fragments — which are not worth showing even when on-topic; content-free insults or toxic name-calling; advertising, referral or self-promotion unrelated to the video; any other content whose quality is too low or too unrelated to the video subject to be worth showing. Judge topical relevance against `danmaku_window.subtitle_in_window` (what is being said on screen right now) and the video metadata.',
    false: 'Acceptable for this window: reactions that match the current moment, including reward-related messages WHILE the video is actually announcing or discussing its own giveaway in this window; jokes about what is shown; questions or opinions about the video subject; the uploader\'s memes, catchphrases and channel-culture chants, which are acceptable in ANY window even when not matching the current moment. When unsure, lean toward acceptable: letting some spam through is better than deleting acceptable content.',
};

const QUALITY_LEVELS = [
    'Spam for this moment of the video: giveaway-begging while the video is not currently discussing its giveaway in this window, pure repeated characters, content-free insults, or off-topic content',
    'Generic filler reaction with little content, e.g. single characters, 哈哈哈, 666, 111',
    'Genuine on-topic reaction to the current moment, including timely giveaway hype while the video is announcing its own giveaway',
    'High-value content: informative observation, useful question or opinion about the video subject',
];

function build_request(video_key: string, pack_lo: int, pack_hi: int, segidx: int, sub_pad_s: int, cands: {text: string, count: int, span_s: number, t_s: number}[]) {
    const state: any = {
        video: {
            title: video_ctx.title || '',
            uploader: video_ctx.uploader || '',
            keywords: video_ctx.keywords || [],
            desc: (video_ctx.desc || '').slice(0, 300),
        },
        danmaku_window: {
            segment_index: segidx,
            time_range_seconds: pack_lo + '~' + pack_hi,
            subtitle_in_window: slice_subtitle(pack_lo - sub_pad_s, pack_hi + sub_pad_s),
        },
        candidates: cands.map((c, i) => ({i, text: c.text, t_seconds: c.t_s, merged_count: c.count, span_seconds: c.span_s})),
        stats_note: 't_seconds = when this danmaku appears inside time_range_seconds; merged_count = how many danmaku were merged into this text after de-duplication; span_seconds = how long this text kept appearing',
    };
    const questions: any = {};
    cands.forEach((c, i) => {
        questions['worst_' + i] = {
            type: 'noul',
            instructions: `Is \`candidates[${i}].text\` at t_seconds=${c.t_s} spam for this moment of the video?`,
            criteria: WORST_CRITERIA,
        };
        questions['qual_' + i] = {
            type: 'score',
            instructions: `Rate the quality of the danmaku \`candidates[${i}].text\` at t_seconds=${c.t_s} for a viewer of this video.`,
            criteria: QUALITY_LEVELS,
        };
    });
    return {state, model: 'jev-latest', questions};
}

async function score_pack(video_key: string, pack_lo: int, pack_hi: int, segidx: int, sub_pad_s: int, items: {cand: Candidate, w_lo_s: int}[], cid: int, use_verdicts: boolean): Promise<{p_worst: number, score: number, text: string}[]> {
    const cands = items.map(it => ({
        text: it.cand.obj.content,
        count: it.cand.count,
        span_s: Math.round(it.cand.span_ms / 100) / 10,
        t_s: Math.round(it.cand.obj.time_ms / 100) / 10,
    }));
    const cache = get_window_cache(video_key);
    const cache_key = hash_str(JSON.stringify([pack_lo, segidx, cands]));
    const hit = cache.get(cache_key);
    if(hit)
        return hit;

    // L2: persistent verdicts (same model only), reused without any request
    let out: {p_worst: number, score: number, text: string}[] = items.map(() => ({p_worst: 0, score: 2, text: ''}));
    let miss_idx: int[] = items.map((_, i) => i);
    if(use_verdicts && cid) {
        let store = await load_verdict_store();
        miss_idx = [];
        items.forEach((it, i) => {
            let v = store[verdict_key(cid, it.w_lo_s, it.cand.obj.content)];
            if(v && v.m === AI_MODEL)
                out[i] = {p_worst: v.p, score: v.s, text: it.cand.obj.content};
            else
                miss_idx.push(i);
        });
        if(!miss_idx.length) {
            cache.set(cache_key, out);
            return out;
        }
    }

    const sub = miss_idx.map(i => items[i]);
    const sub_cands = miss_idx.map(i => cands[i]);
    const body = build_request(video_key, pack_lo, pack_hi, segidx, sub_pad_s, sub_cands);

    let answers: any = null;
    let last_retry_after = 0;
    for(let attempt = 0; attempt <= AI_RETRIES; attempt++) {
        if(attempt > 0)
            await sleep_ms(Math.max(AI_RETRY_BASE_MS * Math.pow(2, attempt - 1), last_retry_after));
        await rl_acquire(); // pace every attempt (first tries and backoff retries) under the quota
        try {
            const resp = await call_jev(body);
            answers = resp && resp.answers;
            if(!answers)
                throw new Error('jev: no answers');
            break;
        } catch(e: any) {
            if(e instanceof RetryableError && attempt < AI_RETRIES) {
                last_retry_after = e.retry_after_ms;
                console.warn(`pakku ai_filter: rate limited, backoff retry ${attempt + 1}/${AI_RETRIES}`);
                continue;
            }
            throw e;
        }
    }
    if(!answers)
        throw new Error('jev: no answers');

    let store: {[k: string]: any} | null = null;
    if(use_verdicts && cid)
        store = await load_verdict_store();
    sub.forEach((it, j) => {
        const p_worst = answers['worst_' + j] ? answers['worst_' + j].noul : 0;
        const score = answers['qual_' + j] ? answers['qual_' + j].score : 2;
        out[miss_idx[j]] = {p_worst, score, text: it.cand.obj.content};
        if(store !== null) {
            store[verdict_key(cid, it.w_lo_s, it.cand.obj.content)] = {
                p: p_worst, s: score, m: AI_MODEL, t: Date.now(), b: get_bvid_from_url(),
            };
            schedule_verdict_flush();
        }
    });
    cache.set(cache_key, out);
    return out;
}

// ---- concurrency limiter for Jev requests (shared across all segments) ----
class Semaphore {
    // priority semaphore: when a slot frees, the waiter closest to the current
    // playhead is woken first, so scoring follows playback progress regardless
    // of the order tasks were created (segments complete in arbitrary order)
    private active = 0;
    private waiters: {resolve: ()=>void, prio: ()=>number}[] = [];
    limit: number;
    constructor(limit: number) {
        this.limit = limit;
    }
    private wake_one() {
        // the waker books the slot; the woken acquire() must not increment again
        while(this.waiters.length && this.active < this.limit) {
            let best = 0;
            for(let i = 1; i < this.waiters.length; i++)
                if(this.waiters[i].prio() < this.waiters[best].prio())
                    best = i; // ties keep the earlier waiter (stable scan from 0)
            const w = this.waiters.splice(best, 1)[0];
            this.active++;
            w.resolve();
        }
    }
    update_limit(limit: number) {
        this.limit = limit;
        this.wake_one();
    }
    async acquire(prio?: ()=>number): Promise<void> {
        if(this.active < this.limit) {
            this.active++;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push({resolve, prio: prio || (() => 0)}));
    }
    release() {
        this.active--;
        this.wake_one();
    }
}
const global_sem = new Semaphore(8);

// ---- diagnostic log (viewable & exportable from the options page) ----
// incremental stats hook: the scheduler registers a callback so per-window
// deletions land in the popup/badge live during the (long) full-judgment
// wait; the scheduler relies on these deltas exclusively for ai_deleted
let ai_stats_hook: ((delta_deleted: int)=>void) | null = null;
export function set_ai_stats_hook(fn: ((delta_deleted: int)=>void) | null) {
    ai_stats_hook = fn;
}
function ai_report_deleted(delta: int) {
    if(delta > 0 && ai_stats_hook)
        try { ai_stats_hook(delta); } catch(e) {}
}

function ai_log_append(rec: any) {
    try {
        chrome.runtime.sendMessage({type: 'ai_log_append', rec}, () => void chrome.runtime.lastError);
    } catch(e) {}
}

// ---- persistent verdict cache (L2, survives reloads; designed for later sharing) ----
// entry: {p: p_worst, s: score, m: model, t: timestamp_ms, b: bvid}; key: cid|window_lo|text
const VERDICT_STORE_KEY = 'ai_verdicts';
const VERDICT_STORE_CAP = 20000;
const AI_MODEL = 'jev-latest';
let verdict_store: {[k: string]: any} | null = null; // null = not loaded yet
let verdict_dirty = false;
let verdict_flush_timer: any = null;

function load_verdict_store(): Promise<{[k: string]: any}> {
    if(verdict_store)
        return Promise.resolve(verdict_store);
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(VERDICT_STORE_KEY, (st: any) => {
                verdict_store = (st && st[VERDICT_STORE_KEY]) || {};
                resolve(verdict_store!);
            });
        } catch(e) {
            verdict_store = {};
            resolve(verdict_store);
        }
    });
}

function verdict_key(cid: int, win_lo: int, text: string): string {
    return cid + '|' + win_lo + '|' + text;
}

function flush_verdict_store() {
    if(!verdict_dirty || !verdict_store)
        return;
    verdict_dirty = false;
    try {
        void chrome.storage.local.set({[VERDICT_STORE_KEY]: verdict_store});
    } catch(e) {}
}

function schedule_verdict_flush() {
    verdict_dirty = true;
    if(verdict_flush_timer !== null)
        return;
    verdict_flush_timer = setTimeout(() => {
        verdict_flush_timer = null;
        if(verdict_store) { // prune oldest 20% when over cap
            let ks = Object.keys(verdict_store);
            if(ks.length > VERDICT_STORE_CAP) {
                let entries = ks.map(k => [k, verdict_store![k].t || 0] as [string, int]).sort((a, b) => a[1] - b[1]);
                for(let i = 0; i < Math.floor(entries.length * 0.2); i++)
                    delete verdict_store[entries[i][0]];
            }
        }
        flush_verdict_store();
    }, 2000);
}

// ---- playback gate: pause the video while scoring is not safely ahead ----
// Danmaku responses wait for full scoring, so filtering is always complete
// before the player renders them; the gate keeps playback from outrunning the
// scorer. Simplified policy (full-judgment mode): as soon as gating starts on
// a video (right when danmaku processing begins, at page entry) the video is
// paused and covered with a loading overlay; playback resumes only when ALL
// windows of ALL loaded segments are scored — the danmaku the player then
// shows are fully filtered from the first frame. While gated, user pause/play
// state is deliberately overridden (resume happens unconditionally). If no
// window completes for GATE_STALL_MS (API broken), the gate gives up
// (fail-open) and playback proceeds with unjudged danmaku.
let gate_pending = new Set<number>();        // absolute window indices registered but not done
let gate_done = new Set<number>();           // windows fully scored (or nothing eligible)
let gate_max_end_s = 0;                      // furthest second covered by any registered window
let gate_video_id = 0;
let gate_window_s = 5;
let gate_enabled = false;
let gate_timer: any = null;
let gate_no_video_ticks = 0;
let gate_overlay: HTMLElement | null = null;
let gate_paused_by_us = false; // we own the resume for the current pause (user state overridden)
let gate_pause_started = 0;
let gate_gave_up = false;
let gate_done_seconds = 0;
let gate_last_progress_ts = 0; // last time a window completed; stalls trigger fail-open
let gate_rate_samples: [number, number][] = []; // [ts, cumulative scored seconds]
const GATE_STALL_MS = 45000;

function gate_reset_for_video(video_id: number) {
    if(gate_video_id === video_id)
        return; // same video, another segment: windows accumulate across segments
    gate_video_id = video_id;
    gate_pending = new Set();
    gate_done = new Set();
    gate_max_end_s = 0;
    gate_done_seconds = 0;
    gate_last_progress_ts = Date.now();
    gate_rate_samples = [];
    gate_gave_up = false;
}

function gate_register(w: number, window_s: number, eligible: number) {
    gate_max_end_s = Math.max(gate_max_end_s, (w + 1) * window_s);
    if(eligible >= 3)
        gate_pending.add(w);
    else
        gate_window_done(w, window_s);
}

function gate_window_done(w: number, window_s: number) {
    // must run before the idempotence check: a re-registered window (re-request
    // of the same range) re-adds itself to pending, and the early return below
    // would otherwise leave it stuck there forever
    gate_pending.delete(w);
    if(gate_done.has(w))
        return;
    gate_done.add(w);
    gate_last_progress_ts = Date.now();
    // "done seconds" counts continuous scored coverage from t=0 (the number the
    // overlay shows and the rate estimator differentiates); windows completed
    // out of order only extend the run when they close the gap
    let run_end = 0;
    while(gate_done.has(run_end))
        run_end++;
    if(run_end * window_s > gate_done_seconds)
        gate_done_seconds = run_end * window_s;
    gate_rate_samples.push([Date.now(), gate_done_seconds]);
    while(gate_rate_samples.length > 200)
        gate_rate_samples.shift();
}

function gate_rate(): number { // scored video-seconds per wall-clock second
    let now = Date.now();
    while(gate_rate_samples.length >= 2 && now - gate_rate_samples[0][0] > 10000)
        gate_rate_samples.shift();
    if(gate_rate_samples.length < 2)
        return 0;
    let [t0, s0] = gate_rate_samples[0];
    let [t1, s1] = gate_rate_samples[gate_rate_samples.length - 1];
    let dt = (t1 - t0) / 1000;
    if(dt <= 0.3)
        return 0;
    return (s1 - s0) / dt;
}

function gate_fmt_s(s: number): string {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// playhead position used for scoring priority; cached briefly so semaphore
// wake-ups do not hit the DOM
let _prio_playhead_s = 0;
let _prio_playhead_ts = 0;
function gate_current_playhead_s(): number {
    let now = Date.now();
    if(now - _prio_playhead_ts < 400)
        return _prio_playhead_s;
    _prio_playhead_ts = now;
    try {
        let video = document.querySelector('video');
        _prio_playhead_s = video ? (video.currentTime || 0) : 0;
    } catch(e) {}
    return _prio_playhead_s;
}

function gate_arm(enabled: boolean, window_s: number) {
    gate_enabled = enabled;
    gate_window_s = window_s;
    if(enabled && gate_timer === null)
        gate_timer = setTimeout(gate_tick, 200);
}

function gate_shutdown_timer() {
    if(gate_timer !== null) {
        clearTimeout(gate_timer);
        gate_timer = null;
    }
}

function gate_tick() {
    gate_timer = null;
    try {
        let video: HTMLVideoElement | null = null;
        try {
            video = document.querySelector('video');
        } catch(e) {}
        if(!video || !gate_enabled || !(document as any).body) {
            gate_no_video_ticks++;
            gate_hide_overlay();
            // note: gate_paused_by_us is kept so the give-up clock is not reset by
            // the player swapping/recreating its <video> element during load
            // stop polling when there is nothing to gate (also lets tests exit)
            if(gate_no_video_ticks < 10)
                gate_timer = setTimeout(gate_tick, 1000);
            return;
        }
        gate_no_video_ticks = 0;

        if(gate_gave_up) { // fail-open after an over-long wait: stop gating this video
            gate_hide_overlay();
            gate_paused_by_us = false;
            gate_timer = setTimeout(gate_tick, 2000);
            return;
        }

        // full-judgment gate: ANY pending window anywhere (any loaded segment)
        // holds playback — the player's responses already wait for full scoring,
        // so the gate simply makes the video wait for the very same completion.
        // This cannot deadlock on lazy segment fetching: bilibili pulls later
        // segments while playing, but those arrive only after the gate released.
        let unsafe = gate_pending.size > 0;

        if(unsafe) {
            if(!video.paused) {
                try {
                    video.pause();
                } catch(e) {}
                gate_pause_started = Date.now();
            } else if(!gate_paused_by_us) {
                // already paused (entry autoplay blocked, or the user paused over us):
                // we still take over the resume, overriding the user deliberately
                gate_pause_started = Date.now();
            }
            gate_paused_by_us = true;
            if(gate_last_progress_ts && Date.now() - gate_last_progress_ts > GATE_STALL_MS) {
                // no window completed for a long while (API broken / all stalled):
                // fail-open, stop gating this video
                gate_gave_up = true;
                gate_hide_overlay();
                gate_paused_by_us = false;
                try {
                    video.play().catch(()=>{});
                } catch(e) {}
            } else {
                gate_show_overlay(video);
                gate_update_overlay();
            }
        } else {
            gate_hide_overlay();
            if(gate_paused_by_us) {
                gate_paused_by_us = false;
                try {
                    video.play().catch(()=>{});
                } catch(e) {}
            }
        }
        gate_timer = setTimeout(gate_tick, 500);
    } catch(e) {
        console.warn('pakku ai_filter: gate tick error', e);
        gate_timer = setTimeout(gate_tick, 1000);
    }
}

function gate_show_overlay(video: HTMLVideoElement) {
    if(gate_overlay)
        return;
    let style = document.getElementById('pakku-ai-gate-style');
    if(!style) {
        style = document.createElement('style');
        style.id = 'pakku-ai-gate-style';
        style.textContent = '@keyframes pakku-ai-gate-spin { to { transform: rotate(360deg); } }';
        (document.head || document.documentElement).appendChild(style);
    }
    let host = (video.closest('.bpx-player-container, #bilibili-player, .bpx-player') as HTMLElement) || video.parentElement;
    if(!host)
        return;
    if(getComputedStyle(host).position === 'static')
        host.style.position = 'relative';
    let ov = document.createElement('div');
    ov.id = 'pakku-ai-gate';
    ov.style.cssText = 'position:absolute;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;'
        + 'background:rgba(0,0,0,.5);pointer-events:none;font-family:sans-serif;';
    ov.innerHTML = '<div style="text-align:center;color:#fff;user-select:none;">'
        + '<div style="width:44px;height:44px;margin:0 auto 10px;border:4px solid rgba(255,255,255,.25);'
        + 'border-top-color:#fb7299;border-radius:50%;animation:pakku-ai-gate-spin .9s linear infinite;"></div>'
        + '<div style="font-size:15px;">AI 正在过滤弹幕</div>'
        + '<div data-sub style="font-size:12px;opacity:.85;margin-top:6px;"></div></div>';
    host.appendChild(ov);
    gate_overlay = ov;
    gate_update_overlay();
}

function gate_update_overlay() {
    if(!gate_overlay)
        return;
    let sub = gate_overlay.querySelector('[data-sub]') as HTMLElement | null;
    if(!sub)
        return;
    let rate = gate_rate();
    // ETA from ALL pending work: full-judgment gating waits for everything
    let pending_s = gate_pending.size * gate_window_s;
    let eta = rate > 0.05 && pending_s > 0 ? Math.ceil(pending_s / rate) : null;
    sub.textContent = `已过滤 ${gate_fmt_s(gate_done_seconds)}${gate_max_end_s ? ' / ' + gate_fmt_s(gate_max_end_s) : ''}`
        + (eta !== null ? `，预计还需 ${eta} 秒` : '');
}

function gate_hide_overlay() {
    if(gate_overlay) {
        try {
            gate_overlay.remove();
        } catch(e) {}
        gate_overlay = null;
    }
}

function jev_ready(): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({type: 'jev_ready'}, (resp: any) => {
                if(chrome.runtime.lastError)
                    return resolve(false);
                resolve(!!(resp && resp.ready));
            });
        } catch(e) {
            resolve(false);
        }
    });
}

function refresh_video_ctx_from_dom() {
    if(video_ctx.title)
        return;
    try {
        let title = (document.querySelector('h1.video-title') as HTMLElement)?.textContent?.trim()
            || document.title.replace(/_哔哩哔哩_bilibili.*$/, '').replace(/_哔哩哔哩.*$/, '').trim() || '';
        let uploader = (document.querySelector('a.up-name, .up-name, [itemprop="author"]') as HTMLElement)?.textContent?.trim() || '';
        let keywords = (document.querySelector('meta[itemprop="keywords"], meta[name="keywords"]') as HTMLMetaElement)?.content || '';
        if(title)
            video_ctx = {
                title,
                uploader: uploader.slice(0, 50),
                keywords: keywords.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12),
            };
        console.debug('pakku ai_filter: video ctx', video_ctx);
    } catch(e) {
        console.warn('pakku ai_filter: cannot read video ctx from DOM', e);
    }
}

// subtitle context (fetched once per video through the background proxy;
// the user's own bilibili login cookies are used, credentials: include)
interface SubtitleLine {from: number, to: number, content: string}
let subtitle_lines: SubtitleLine[] | null = null;
let subtitle_video_key = '';

function get_bvid_from_url(): string {
    try {
        let m = location.pathname.match(/BV[0-9A-Za-z]{10}/);
        return m ? m[0] : '';
    } catch(e) {
        return ''; // non-browser context (tests)
    }
}

function fetch_subtitle(bvid: string, cid: int): Promise<SubtitleLine[] | null> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({type: 'bili_subtitle', bvid, cid}, (resp: any) => {
                if(chrome.runtime.lastError || !resp || resp.error)
                    return resolve(null);
                resolve(resp.lines || []);
            });
        } catch(e) {
            resolve(null);
        }
    });
}

async function ensure_subtitle(video_key: string, bvid: string, cid: int, timeout_ms: int) {
    if(subtitle_video_key === video_key)
        return; // already fetched (or failed) for this video
    subtitle_video_key = video_key;
    let lines = await with_timeout(fetch_subtitle(bvid, cid), timeout_ms, null);
    subtitle_lines = lines;
    if(lines && lines.length)
        console.debug(`pakku ai_filter: subtitle context loaded, ${lines.length} lines`);
    else
        console.debug('pakku ai_filter: no subtitle context (not logged in, no AI subtitle, or fetch failed)');
}

function slice_subtitle(lo_s: number, hi_s: number): string {
    if(!subtitle_lines || !subtitle_lines.length)
        return '';
    let parts: string[] = [];
    for(const l of subtitle_lines) {
        if(l.to > lo_s && l.from < hi_s)
            parts.push(l.content);
        if(l.from >= hi_s)
            break;
    }
    let joined = parts.join(' ');
    return joined.length > 800 ? joined.slice(0, 800) : joined;
}

export interface AiFilterResult {
    chunk: DanmuChunk<DanmuObjectRepresentative>;
    ai_deleted: int;
    ai_deleted_ratio: int;
    ai_windows: int;
    ai_error: string | null;
}

export async function ai_filter_chunk(
    chunk: DanmuChunk<DanmuObjectRepresentative>,
    config: LocalizedConfig,
    segidx: int,
): Promise<AiFilterResult> {
    const ret: AiFilterResult = {chunk, ai_deleted: 0, ai_deleted_ratio: 0, ai_windows: 0, ai_error: null};
    if(!config.AI_FILTER)
        return ret;

    refresh_video_ctx_from_dom();
    if(!await jev_ready()) {
        console.warn('pakku ai_filter: no API key configured, skipping AI filter');
        ret.ai_error = 'no_api_key';
        return ret;
    }

    const max_cand = Math.max(5, config.AI_MAX_CANDIDATES || 50);
    const del_thr = typeof config.AI_DELETE_THRESHOLD === 'number' ? config.AI_DELETE_THRESHOLD : 0.6;
    const ratio = typeof config.AI_RATIO === 'number' ? config.AI_RATIO : 0;
    const sub_pad_s = Math.max(0, config.AI_SUBTITLE_PADDING_SECONDS ?? 5);
    const concurrency = Math.max(1, config.AI_CONCURRENCY || 8);
    // full-judgment mode: the response waits until EVERY window of the segment
    // is scored (the playback gate pauses the video to cover the wait); the
    // budget is only a safety valve against pathological hangs
    const budget_ms = Math.max(0, config.AI_BUDGET_MS ?? 300000);
    const max_text_len = Math.max(1, config.AI_MAX_TEXT_LEN ?? 40);
    const pause_gate = config.AI_PAUSE_GATE !== false;

    const video_key = String(video_ctx.title || '') + '|' + (chunk.extra.proto_segidx !== undefined ? chunk.extra.proto_segidx : segidx);

    // subtitle context: cid comes from the intercepted danmaku stream, bvid from the page URL
    let cid = 0;
    for(const obj of chunk.objs) {
        if(obj.extra && obj.extra.proto_oid) {
            cid = obj.extra.proto_oid;
            break;
        }
    }
    let bvid = get_bvid_from_url();

    // the playback gate starts with danmaku processing: the video is paused
    // immediately (covered by the overlay) and resumes once scoring leads

    // responses normally wait for full scoring (the playback gate pauses the
    // video to cover the wait); the budget is only a safety valve against
    // pathological hangs
    const deadline = Date.now() + budget_ms;
    const t_start = Date.now();

    if(cid && bvid)
        await ensure_subtitle('cid_' + cid, bvid, cid, Math.min(2500, Math.max(0, deadline - Date.now())));

    // bucket merged clusters into semantic windows
    const windows = new Map<int, Candidate[]>();
    chunk.objs.forEach((obj, idx) => {
        const w = Math.floor(obj.time_ms / SEMANTIC_WINDOW_MS);
        const peers = (obj as any).pakku && (obj as any).pakku.peers as {time_ms: int}[] | undefined;
        const count = Math.max(1, peers ? peers.length : 1);
        let span_ms = 0;
        if(peers && peers.length) {
            let lo = Infinity, hi = -Infinity;
            for(const p of peers) {
                if(p.time_ms < lo) lo = p.time_ms;
                if(p.time_ms > hi) hi = p.time_ms;
            }
            span_ms = Math.max(0, hi - lo);
        }
        let arr = windows.get(w);
        if(!arr) {
            arr = [];
            windows.set(w, arr);
        }
        arr.push({obj, idx, count, span_ms});
    });

    const deleted = new Set<int>();
    const ratio_deleted = new Set<int>();
    global_sem.update_limit(concurrency);
    let windows_done = 0;
    let long_skipped_count = 0;
    gate_reset_for_video(cid || parseInt(hash_str(video_key), 36) || 0);
    gate_arm(pause_gate, SEMANTIC_WINDOW_S);

    // judged windows (>=3 candidates after the length limit), chronological
    const judged: JudgedWindow[] = [];
    for(const [w, cands_all] of [...windows.entries()].sort((a, b) => a[0] - b[0])) {
        // length limit: over-long danmaku skip judgement and pass through
        const cands = cands_all.filter(c => c.obj.content.length <= max_text_len);
        long_skipped_count += cands_all.length - cands.length;

        gate_register(w, SEMANTIC_WINDOW_S, cands.length);
        if(cands.length < 3)
            continue; // tiny window: not worth a request, keep everything
        ret.ai_windows++;

        // high merged count first: the spam signature leads each request
        judged.push({
            w,
            lo_s: Math.floor(w * SEMANTIC_WINDOW_S),
            hi_s: Math.floor((w + 1) * SEMANTIC_WINDOW_S),
            cands: [...cands].sort((a, b) => b.count - a.count),
        });
    }

    // pack adjacent judged windows into shared requests, bounded by candidate
    // count (<= max_cand) and time span (<= PACK_SPAN_S); ratio ranking, the
    // tiny-window exemption and the verdict cache keep using the semantic
    // window, not the pack
    const packs: RequestPack[] = [];
    let cur_pack: RequestPack | null = null;
    for(const win of judged) {
        let rest = win.cands;
        while(rest.length) {
            if(!cur_pack || cur_pack.count >= max_cand || win.hi_s - cur_pack.lo_s > PACK_SPAN_S) {
                cur_pack = {lo_s: win.lo_s, hi_s: win.hi_s, count: 0, entries: []};
                packs.push(cur_pack);
            }
            const take = Math.min(rest.length, max_cand - cur_pack.count);
            cur_pack.entries.push({win, part: rest.slice(0, take)});
            cur_pack.count += take;
            cur_pack.hi_s = win.hi_s;
            rest = rest.slice(take);
        }
    }

    // per-window completion bookkeeping: a window (and its gate slot and ratio
    // layer) settles only after every pack containing it has returned
    const win_state = new Map<int, {win: JudgedWindow, survivors: {c: Candidate, score: number}[], log_cands: any[], pending: int, err: string | null, t0: int}>();
    for(const win of judged)
        win_state.set(win.w, {win, survivors: [], log_cands: [], pending: 0, err: null, t0: 0});
    for(const p of packs)
        for(const e of p.entries)
            win_state.get(e.win.w)!.pending++;

    const finish_window = (w: int) => {
        const st = win_state.get(w)!;
        // ratio layer: among survivors, drop the worst floor(n*ratio)
        if(ratio > 0 && st.survivors.length >= 5) {
            const drop_n = Math.floor(st.survivors.length * ratio);
            if(drop_n > 0) {
                st.survivors.sort((a, b) => a.score - b.score);
                for(let i = 0; i < drop_n; i++) {
                    ratio_deleted.add(st.survivors[i].c.idx);
                    ret.ai_deleted_ratio += st.survivors[i].c.count;
                    ai_report_deleted(st.survivors[i].c.count);
                    let lc = st.log_cands.find(x => x.t === st.survivors[i].c.obj.content && x.k === 1);
                    if(lc)
                        lc.k = 2;
                }
            }
        }
        windows_done++;
        gate_window_done(w, SEMANTIC_WINDOW_S);
        ai_log_append({
            type: 'window', ts: Date.now(), segidx, window: st.win.lo_s + '~' + st.win.hi_s,
            cands: st.log_cands.length, del_spam: st.log_cands.filter(x => x.k === 0).length,
            del_ratio: st.log_cands.filter(x => x.k === 2).length,
            api_ms: Date.now() - st.t0, error: st.err,
            detail: st.log_cands.slice(0, 80),
        });
    };

    const tasks = packs.map((p) => (async () => {
        const items = p.entries.flatMap(e => e.part.map(cand => ({cand, w_lo_s: e.win.lo_s})));
        for(const e of p.entries) {
            const st = win_state.get(e.win.w)!;
            if(!st.t0)
                st.t0 = Date.now();
        }
        let scores: {p_worst: number, score: number, text: string}[];
        try {
            // priority: score the pack closest to the playhead first, so the
            // video head becomes watchable earliest if the gate ever gives up
            // or is disabled
            await global_sem.acquire(() => Math.abs(p.lo_s - gate_current_playhead_s()));
            try {
                scores = await with_timeout(
                    score_pack(video_key, p.lo_s, p.hi_s, segidx, sub_pad_s, items, cid, config.AI_VERDICT_CACHE === true),
                    60000,
                    items.map(it => ({p_worst: 0, score: 2, text: it.cand.obj.content})), // fail-open
                );
            } finally {
                global_sem.release();
            }
        } catch(e: any) {
            console.warn('pakku ai_filter: pack failed (fail-open)', e);
            const msg = e && e.message || String(e);
            for(const e2 of p.entries)
                win_state.get(e2.win.w)!.err = msg;
            scores = items.map(it => ({p_worst: 0, score: 2, text: it.cand.obj.content}));
        }
        let i = 0;
        for(const e of p.entries) {
            const st = win_state.get(e.win.w)!;
            for(const c of e.part) {
                const s = scores[i++];
                if(s && s.p_worst >= del_thr) {
                    deleted.add(c.idx);
                    ret.ai_deleted += c.count;
                    ai_report_deleted(c.count);
                    st.log_cands.push({t: c.obj.content, n: c.count, p: s.p_worst, s: s.score, k: 0});
                } else {
                    st.survivors.push({c, score: s ? s.score : 2});
                    st.log_cands.push({t: c.obj.content, n: c.count, p: s ? s.p_worst : 0, s: s ? s.score : 2, k: 1});
                }
            }
            st.pending--;
            if(st.pending === 0)
                finish_window(e.win.w);
        }
    })());

    // full judgment: wait for EVERY window of this segment before returning the
    // chunk (fail-open on the budget only, against pathological hangs — the
    // playback gate keeps the video paused for the same wait anyway)
    await Promise.race([
        Promise.all(tasks),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
    ]);

    if(deleted.size || ratio_deleted.size) {
        ret.chunk = {
            objs: chunk.objs.filter((_, idx) => !deleted.has(idx) && !ratio_deleted.has(idx)),
            extra: chunk.extra,
        };
    }
    // verdicts persist once every window (including any budget-fail-open ones
    // still finishing in the background) has settled
    void Promise.all(tasks).then(() => flush_verdict_store());
    if(ret.ai_windows) {
        const budget_hit = windows_done < ret.ai_windows;
        console.info(`pakku ai_filter: seg ${segidx} windows=${ret.ai_windows} packs=${packs.length} done=${windows_done}/${ret.ai_windows} budget_hit=${budget_hit} deleted(spam)=${ret.ai_deleted} deleted(ratio)=${ret.ai_deleted_ratio} kept=${ret.chunk.objs.length}/${chunk.objs.length} ship_ms=${Date.now() - t_start}`);
        ai_log_append({
            type: 'seg', ts: Date.now(), segidx, title: video_ctx.title || '', bvid,
            windows: ret.ai_windows, packs: packs.length, done: windows_done, budget_hit,
            del_spam: ret.ai_deleted, del_ratio: ret.ai_deleted_ratio,
            kept: ret.chunk.objs.length, total: chunk.objs.length, ship_ms: Date.now() - t_start,
            long_skipped: long_skipped_count,
        });
    }
    return ret;
}
