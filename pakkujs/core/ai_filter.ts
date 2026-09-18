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
    true: 'Lottery-begging (asking to win a giveaway), pure repeated characters, off-topic chatter, or flooding text unrelated to the video subject. IMPORTANT: repetitive short begging messages sent by many users at once (e.g. 中, 中中中, 抽我, 求中奖) are spam EVEN WHEN the video is currently discussing its own giveaway or the message matches what is on screen right now: flooding the screen with begging is spam regardless of momentary topical relevance. Judge by whether the message is substantive content, not by whether its topic momentarily matches the screen.',
    false: 'Substantively related to the video content: meaningful on-topic reactions, jokes about what is shown, the uploader\'s memes, questions or opinions about the video subject.',
};

const QUALITY_LEVELS = [
    'Spam or unrelated: lottery-begging (asking to be picked in a giveaway), pure repeated characters, off-topic content',
    'Generic filler reaction with little content, e.g. single characters, 哈哈哈, 666, 111',
    'Genuine on-topic reaction, joke or comment about the video content',
    'High-value content: informative observation, useful question or opinion about the video subject',
];

function build_request(video_key: string, window_lo: int, window_hi: int, segidx: int, cands: {text: string, count: int, span_s: number}[]) {
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
            subtitle_in_window: slice_subtitle(window_lo, window_hi),
        },
        candidates: cands.map((c, i) => ({i, text: c.text, merged_count: c.count, span_seconds: c.span_s})),
        stats_note: 'merged_count = how many danmaku were merged into this text after de-duplication; span_seconds = how long this text kept appearing inside this window',
    };
    const questions: any = {};
    cands.forEach((_, i) => {
        questions['worst_' + i] = {
            type: 'noul',
            instructions: `Is \`candidates[${i}].text\` low-quality danmaku spam that is unrelated to what this video is about?`,
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

async function score_batch(video_key: string, window_lo: int, window_hi: int, segidx: int, batch: Candidate[]): Promise<{p_worst: number, score: number, text: string}[]> {
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

    const body = build_request(video_key, window_lo, window_hi, segidx, cands);
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

async function ensure_subtitle(video_key: string, bvid: string, cid: int) {
    if(subtitle_video_key === video_key)
        return; // already fetched (or failed) for this video
    subtitle_video_key = video_key;
    let lines = await with_timeout(fetch_subtitle(bvid, cid), 5000, null);
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

    const win_ms = Math.max(5, config.AI_WINDOW_SECONDS || 30) * 1000;
    const max_cand = Math.max(5, config.AI_MAX_CANDIDATES || 50);
    const del_thr = typeof config.AI_DELETE_THRESHOLD === 'number' ? config.AI_DELETE_THRESHOLD : 0.6;
    const ratio = typeof config.AI_RATIO === 'number' ? config.AI_RATIO : 0;

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
        await ensure_subtitle('cid_' + cid, bvid, cid);

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

    const tasks: Promise<void>[] = [];
    for(const [w, cands] of windows) {
        if(cands.length < 3)
            continue; // tiny window: not worth a request, keep everything
        ret.ai_windows++;

        // score in batches of max_cand, prioritising high merged count (spam signature)
        const sorted = [...cands].sort((a, b) => b.count - a.count);
        const batches: Candidate[][] = [];
        for(let i = 0; i < sorted.length; i += max_cand)
            batches.push(sorted.slice(i, i + max_cand));

        tasks.push((async () => {
            const survivors: {c: Candidate, score: number}[] = [];
            for(const batch of batches) {
                let scores: {p_worst: number, score: number, text: string}[];
                try {
                    scores = await with_timeout(
                        score_batch(video_key, Math.floor(w * win_ms / 1000), Math.floor((w + 1) * win_ms / 1000), segidx, batch),
                        15000,
                        batch.map(c => ({p_worst: 0, score: 2, text: c.obj.content})), // fail-open
                    );
                } catch(e: any) {
                    console.warn('pakku ai_filter: window batch failed (fail-open)', e);
                    scores = batch.map(c => ({p_worst: 0, score: 2, text: c.obj.content}));
                }
                batch.forEach((c, i) => {
                    const s = scores[i];
                    if(s && s.p_worst >= del_thr) {
                        deleted.add(c.idx);
                        ret.ai_deleted += c.count;
                    } else {
                        survivors.push({c, score: s ? s.score : 2});
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
                    }
                }
            }
        })());
    }

    await Promise.all(tasks);

    if(deleted.size || ratio_deleted.size) {
        ret.chunk = {
            objs: chunk.objs.filter((_, idx) => !deleted.has(idx) && !ratio_deleted.has(idx)),
            extra: chunk.extra,
        };
    }
    if(ret.ai_windows)
        console.info(`pakku ai_filter: seg ${segidx} windows=${ret.ai_windows} deleted(spam)=${ret.ai_deleted} deleted(ratio)=${ret.ai_deleted_ratio} kept=${ret.chunk.objs.length}/${chunk.objs.length}`);
    return ret;
}
