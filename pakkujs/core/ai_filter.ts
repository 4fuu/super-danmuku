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
                if(!resp || resp.error)
                    return reject(new Error((resp && resp.error) || 'jev_call failed'));
                resolve(resp.data);
            });
        } catch(e) {
            reject(e as Error);
        }
    });
}

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

function build_request(video_key: string, window_lo: int, window_hi: int, segidx: int, sub_pad_s: int, cands: {text: string, count: int, span_s: number}[]) {
    const state: any = {
        video: {
            title: video_ctx.title || '',
            uploader: video_ctx.uploader || '',
            keywords: video_ctx.keywords || [],
            desc: (video_ctx.desc || '').slice(0, 300),
        },
        danmaku_window: {
            segment_index: segidx,
            time_range_seconds: window_lo + '~' + window_hi,
            subtitle_in_window: slice_subtitle(window_lo - sub_pad_s, window_hi + sub_pad_s),
        },
        candidates: cands.map((c, i) => ({i, text: c.text, merged_count: c.count, span_seconds: c.span_s})),
        stats_note: 'merged_count = how many danmaku were merged into this text after de-duplication; span_seconds = how long this text kept appearing inside this window',
    };
    const questions: any = {};
    cands.forEach((_, i) => {
        questions['worst_' + i] = {
            type: 'noul',
            instructions: `Is \`candidates[${i}].text\` spam for this window of the video?`,
            criteria: WORST_CRITERIA,
        };
        questions['qual_' + i] = {
            type: 'score',
            instructions: `Rate the quality of the danmaku \`candidates[${i}].text\` for a viewer of this video.`,
            criteria: QUALITY_LEVELS,
        };
    });
    return {state, model: 'jev-latest', questions};
}

async function score_batch(video_key: string, window_lo: int, window_hi: int, segidx: int, sub_pad_s: int, batch: Candidate[]): Promise<{p_worst: number, score: number, text: string}[]> {
    const cands = batch.map(c => ({
        text: c.obj.content,
        count: c.count,
        span_s: Math.round(c.span_ms / 100) / 10,
    }));
    const cache = get_window_cache(video_key);
    const cache_key = hash_str(JSON.stringify([window_lo, segidx, cands]));
    const hit = cache.get(cache_key);
    if(hit)
        return hit;

    const body = build_request(video_key, window_lo, window_hi, segidx, sub_pad_s, cands);
    const resp = await call_jev(body);
    const answers = resp && resp.answers;
    if(!answers)
        throw new Error('jev: no answers');
    const out = batch.map((_, i) => ({
        p_worst: answers['worst_' + i] ? answers['worst_' + i].noul : 0,
        score: answers['qual_' + i] ? answers['qual_' + i].score : 2,
        text: cands[i].text,
    }));
    cache.set(cache_key, out);
    return out;
}

// ---- concurrency limiter for Jev requests ----
class Semaphore {
    private active = 0;
    private waiters: (() => void)[] = [];
    constructor(private limit: number) {}
    async acquire(): Promise<void> {
        if(this.limit <= 0 || this.active < this.limit) {
            this.active++;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        this.active++;
    }
    release() {
        this.active--;
        let next = this.waiters.shift();
        if(next)
            next();
    }
}

// ---- diagnostic log (viewable & exportable from the options page) ----
function ai_log_append(rec: any) {
    try {
        chrome.runtime.sendMessage({type: 'ai_log_append', rec}, () => void chrome.runtime.lastError);
    } catch(e) {}
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

    const win_ms = Math.max(1, config.AI_WINDOW_SECONDS || 5) * 1000;
    const max_cand = Math.max(5, config.AI_MAX_CANDIDATES || 50);
    const del_thr = typeof config.AI_DELETE_THRESHOLD === 'number' ? config.AI_DELETE_THRESHOLD : 0.6;
    const ratio = typeof config.AI_RATIO === 'number' ? config.AI_RATIO : 0;
    const sub_pad_s = Math.max(0, config.AI_SUBTITLE_PADDING_SECONDS ?? 5);
    const concurrency = Math.max(1, config.AI_CONCURRENCY || 4);
    const budget_ms = Math.max(0, config.AI_BUDGET_MS ?? 6000);

    // the response never waits longer than the budget: whatever is scored by the
    // deadline is applied, the rest ships unjudged and keeps scoring in the
    // background so any re-load (seek, danmaku toggle) hits a warm cache
    const deadline = Date.now() + budget_ms;
    const t_start = Date.now();

    const video_key = String(video_ctx.title || '') + '|' + (chunk.extra.proto_segidx !== undefined ? chunk.extra.proto_segidx : segidx) + '|' + chunk.objs.length;

    // subtitle context: cid comes from the intercepted danmaku stream, bvid from the page URL
    let cid = 0;
    for(const obj of chunk.objs) {
        if(obj.extra && obj.extra.proto_oid) {
            cid = obj.extra.proto_oid;
            break;
        }
    }
    let bvid = get_bvid_from_url();
    if(cid && bvid)
        await ensure_subtitle('cid_' + cid, bvid, cid, Math.min(2500, Math.max(0, deadline - Date.now())));

    // bucket merged clusters into time windows
    const windows = new Map<int, Candidate[]>();
    chunk.objs.forEach((obj, idx) => {
        const w = Math.floor(obj.time_ms / win_ms);
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
    const sem = new Semaphore(concurrency);
    let windows_done = 0;

    const tasks: Promise<void>[] = [];
    for(const [w, cands] of [...windows.entries()].sort((a, b) => a[0] - b[0])) { // chronological: near-playhead windows score first
        if(cands.length < 3)
            continue; // tiny window: not worth a request, keep everything
        ret.ai_windows++;

        const w_lo = Math.floor(w * win_ms / 1000);
        const w_hi = Math.floor((w + 1) * win_ms / 1000);

        // score in batches of max_cand, prioritising high merged count (spam signature)
        const sorted = [...cands].sort((a, b) => b.count - a.count);
        const batches: Candidate[][] = [];
        for(let i = 0; i < sorted.length; i += max_cand)
            batches.push(sorted.slice(i, i + max_cand));

        tasks.push((async () => {
            const survivors: {c: Candidate, score: number}[] = [];
            const log_cands: any[] = [];
            const t_win = Date.now();
            let win_err: string | null = null;

            for(const batch of batches) {
                let scores: {p_worst: number, score: number, text: string}[];
                try {
                    await sem.acquire();
                    try {
                        scores = await with_timeout(
                            score_batch(video_key, w_lo, w_hi, segidx, sub_pad_s, batch),
                            15000,
                            batch.map(c => ({p_worst: 0, score: 2, text: c.obj.content})), // fail-open
                        );
                    } finally {
                        sem.release();
                    }
                } catch(e: any) {
                    console.warn('pakku ai_filter: window batch failed (fail-open)', e);
                    win_err = e && e.message || String(e);
                    scores = batch.map(c => ({p_worst: 0, score: 2, text: c.obj.content}));
                }
                batch.forEach((c, i) => {
                    const s = scores[i];
                    if(s && s.p_worst >= del_thr) {
                        deleted.add(c.idx);
                        ret.ai_deleted += c.count;
                        log_cands.push({t: c.obj.content, n: c.count, p: s.p_worst, s: s.score, k: 0});
                    } else {
                        survivors.push({c, score: s ? s.score : 2});
                        log_cands.push({t: c.obj.content, n: c.count, p: s ? s.p_worst : 0, s: s ? s.score : 2, k: 1});
                    }
                });
            }
            // ratio layer: among survivors, drop the worst floor(n*ratio)
            if(ratio > 0 && survivors.length >= 5) {
                const drop_n = Math.floor(survivors.length * ratio);
                if(drop_n > 0) {
                    survivors.sort((a, b) => a.score - b.score);
                    for(let i = 0; i < drop_n; i++) {
                        ratio_deleted.add(survivors[i].c.idx);
                        ret.ai_deleted_ratio += survivors[i].c.count;
                        let lc = log_cands.find(x => x.t === survivors[i].c.obj.content && x.k === 1);
                        if(lc)
                            lc.k = 2;
                    }
                }
            }
            windows_done++;
            ai_log_append({
                type: 'window', ts: Date.now(), segidx, window: w_lo + '~' + w_hi,
                cands: log_cands.length, del_spam: log_cands.filter(x => x.k === 0).length,
                del_ratio: log_cands.filter(x => x.k === 2).length,
                api_ms: Date.now() - t_win, error: win_err,
                detail: log_cands.slice(0, 80),
            });
        })());
    }

    // ship whatever is ready within the budget; remaining windows keep scoring
    // in the background purely to warm the cache for the next load
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
    if(ret.ai_windows) {
        const budget_hit = windows_done < tasks.length;
        console.info(`pakku ai_filter: seg ${segidx} windows=${ret.ai_windows} done=${windows_done}/${tasks.length} budget_hit=${budget_hit} deleted(spam)=${ret.ai_deleted} deleted(ratio)=${ret.ai_deleted_ratio} kept=${ret.chunk.objs.length}/${chunk.objs.length} ship_ms=${Date.now() - t_start}`);
        ai_log_append({
            type: 'seg', ts: Date.now(), segidx, title: video_ctx.title || '', bvid,
            windows: ret.ai_windows, done: windows_done, budget_hit,
            del_spam: ret.ai_deleted, del_ratio: ret.ai_deleted_ratio,
            kept: ret.chunk.objs.length, total: chunk.objs.length, ship_ms: Date.now() - t_start,
        });
    }
    return ret;
}
