// AI spoken-ad skip prompt, powered by Jev (TypeSafe System One).
//
// Independent pipeline next to the danmaku quality filter: it consumes the
// danmaku chunks the scheduler has already downloaded (no extra bilibili
// requests) plus the video's subtitle track, and asks Jev two things:
//   1. screening (初筛): which 30s windows are part of a sponsored ad read
//      for a third-party product, as opposed to the video's own editorial
//      content (brands discussed as the video's TOPIC are not ads)
//   2. boundaries (边界确定): which subtitle lines around each coarse edge
//      are ad copy, pinning the skip target to ~1s accuracy
// All statistics (window grid, de-dup counts, candidate selection, interval
// merging, boundary snapping) stay in code; Jev only makes semantic judgments.
// Every failure mode is fail-open: the scan never blocks danmaku loading or
// playback, and the worst case is simply that no prompt appears.

import {DanmuChunk, DanmuObject, int, LocalizedConfig} from "./types";
import {
    call_jev, RetryableError, rl_acquire, get_jev_semaphore, with_timeout,
    jev_ready, ensure_subtitle, get_subtitle_lines, slice_subtitle,
    refresh_video_ctx_from_dom, get_bvid_from_url, get_video_ctx, ai_log_append,
} from "./ai_filter";

// ---- tuning constants (internal; calibrated against BV17Neb6wE87) ----
const AD_WINDOW_S = 30;          // screening window grid
const AD_PACK_SPAN_S = 90;       // max subtitle time range per screening request
const AD_SCREEN_THRESHOLD = 0.6; // window p(ad) >= this joins an interval
const AD_LINE_THRESHOLD = 0.5;   // subtitle line p(ad) >= this counts as ad copy
const AD_EDGE_PAD_S = 25;        // subtitle lines taken around each coarse edge
const AD_PROMPT_LEAD_S = 5;        // fallback: show the prompt this many seconds before the ad
const AD_PROMPT_TTL_S = 30;        // fallback: prompt auto-dismisses after hanging this long
const AD_NOTE_S = 10;              // fallback: the "skipped" notice shows this many seconds
const AD_NEIGHBOR_EXPAND = 1;    // judged set includes N neighbors of each passing window
const AD_GAP_FILL = 2;           // unjudged holes <= N windows between candidates are filled
const AD_BRIDGE_GAP = 1;         // <= N unjudged windows inside an ad run are bridged
const AD_RETRIES = 5;
const AD_RETRY_BASE_MS = 500;
const AD_MODEL = 'jev-latest';

const AD_CACHE_KEY = 'ai_ad_intervals';
const AD_CACHE_CAP = 2000;
const AD_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

// local pre-screen lexicon: recall-oriented, Jev is the real judge. Promotion
// vocabulary is ASR-stable (unlike brand names, which the ASR mangles).
const AD_PROMO_WORDS = ['赞助', '推广', '广告', '商单', '领券', '下单', '优惠券', '折扣', '旗舰店', '置顶链接',
    '评论区有', '回购率', '热卖', '销量', '全网第一', '粉丝专属', '福利价', '购买链接', '官方旗舰', '专属链接'];
const AD_COMPLAINT_RE = /别念|恰饭|金主|广告|走了走|退了退|下次一定/;
const AD_WELCOME_RE = /欢迎回来|回来了|正片|空降/;
const AD_PRAISE_RE = /买了|回购|已下单|下单了|用着不错|用了.{0,4}效果|皮肤好|控油|清爽/;

// ---- per-video state ----
interface AdInterval {
    start_s: number;
    end_s: number;
    conf: number;
    skipped: boolean;
    dismissed?: boolean; // user pressed ✕: never re-show this visit (prompt AND auto-skip)
    timed_out?: boolean; // prompt hung past its TTL this pass: quiet only while the
                         // playhead stays inside [start-lead, end); leaving the range
                         // re-arms it so seeking back shows the prompt again
}

let scan_cid: int = 0;
let scan_started = false;
let fed_danmaku: {t_ms: int, text: string}[] = [];
let fed_seen: Set<string> = new Set();
let intervals: AdInterval[] = [];
let watch_config: LocalizedConfig | null = null;
let ui_timer: any = null;
let scan_promise: Promise<void> | null = null; // exposed for tests

export function ad_skip_wait(): Promise<void> | null {
    return scan_promise;
}

export function ad_skip_debug_intervals(): {start_s: number, end_s: number, conf: number}[] {
    return intervals.map(iv => ({start_s: iv.start_s, end_s: iv.end_s, conf: iv.conf}));
}

// ---- hooks called from the scheduler (all near-free when disabled) ----

export function ad_skip_on_ingress(ingress: any, config: LocalizedConfig) {
    if(!config.AI_AD_SKIP)
        return;
    if(!ingress || ingress.type !== 'proto_seg')
        return;
    const cid = parseInt(ingress.cid) || 0;
    if(!cid || cid === scan_cid)
        return;
    // new video: reset everything
    scan_cid = cid;
    scan_started = false;
    fed_danmaku = [];
    fed_seen = new Set();
    intervals = [];
    watch_config = config;
}

export function ad_skip_feed_chunk(ingress: any, chunk: DanmuChunk<DanmuObject>) {
    if(!ingress || ingress.type !== 'proto_seg')
        return;
    const cid = parseInt(ingress.cid) || 0;
    if(cid !== scan_cid || scan_started)
        return; // late chunk after the scan began (re-requested range): ignore
    for(const obj of chunk.objs) {
        const key = obj.time_ms + '|' + obj.content;
        if(fed_seen.has(key))
            continue;
        fed_seen.add(key);
        fed_danmaku.push({t_ms: obj.time_ms, text: obj.content});
    }
}

export function ad_skip_begin_scan(ingress: any, config: LocalizedConfig) {
    if(!config.AI_AD_SKIP)
        return;
    if(!ingress || ingress.type !== 'proto_seg')
        return;
    const cid = parseInt(ingress.cid) || 0;
    if(!cid || cid !== scan_cid || scan_started)
        return;
    scan_started = true;
    scan_promise = perform_scan(cid, config).catch((e) => {
        console.warn('pakku ad_skip: scan failed, no prompt will be shown', e);
        ai_log_append({type: 'ad_scan', ts: Date.now(), cid, error: e && (e.message || String(e))});
    });
}

// ---- window statistics (all counting happens here, never in the model) ----

interface WindowStat {
    w: int;
    lo_s: int;
    hi_s: int;
    sub: string;
    danmaku_sample: {text: string, count: int, t_s: number}[];
    promo_hits: int;
    complaints: int;
    welcomes: int;
    praises: int;
    burst: int;
    passes: boolean;
}

function build_window_stats(): WindowStat[] {
    const lines = get_subtitle_lines();
    const max_dm_s = fed_danmaku.length ? Math.max(...fed_danmaku.map(d => d.t_ms)) / 1000 : 0;
    const dur_s = Math.max(lines && lines.length ? lines[lines.length - 1].to : 0, max_dm_s);
    const n_win = Math.max(1, Math.ceil(dur_s / AD_WINDOW_S));
    const stats: WindowStat[] = [];
    for(let w = 0; w < n_win; w++) {
        const lo_s = w * AD_WINDOW_S, hi_s = (w + 1) * AD_WINDOW_S;
        const dms = fed_danmaku.filter(d => d.t_ms >= lo_s * 1000 && d.t_ms < hi_s * 1000);
        const counts = new Map<string, int>();
        const first_t = new Map<string, int>();
        for(const d of dms) {
            counts.set(d.text, (counts.get(d.text) || 0) + 1);
            if(!first_t.has(d.text))
                first_t.set(d.text, d.t_ms);
        }
        const sample = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
            .map(([text, count]) => ({text, count, t_s: Math.round(first_t.get(text)!) / 1000}));
        const sub = slice_subtitle(lo_s - 5, hi_s + 5);
        const promo_hits = AD_PROMO_WORDS.reduce((n, word) => n + (sub.split(word).length - 1), 0);
        const complaints = dms.reduce((n, d) => n + (AD_COMPLAINT_RE.test(d.text) ? 1 : 0), 0);
        const welcomes = dms.reduce((n, d) => n + (AD_WELCOME_RE.test(d.text) ? 1 : 0), 0);
        const praises = dms.reduce((n, d) => n + (AD_PRAISE_RE.test(d.text) ? 1 : 0), 0);
        const burst = Math.max(0, ...[...counts.values()]);
        // recall-oriented pre-screen: any plausible signal sends the window to Jev
        const passes = promo_hits >= 1 || complaints >= 2 || (complaints >= 1 && praises >= 3)
            || burst >= 4 || welcomes >= 1;
        stats.push({w, lo_s, hi_s, sub, danmaku_sample: sample, promo_hits, complaints,
            welcomes, praises, burst, passes});
    }
    return stats;
}

function pick_candidates(stats: WindowStat[]): WindowStat[] {
    const passing = new Set(stats.filter(s => s.passes).map(s => s.w));
    if(!passing.size)
        return [];
    let judged = new Set<int>();
    for(const w of passing) {
        for(let d = -AD_NEIGHBOR_EXPAND; d <= AD_NEIGHBOR_EXPAND; d++)
            judged.add(w + d);
    }
    // fill unjudged holes inside the candidate span so one quiet window cannot
    // split an ad in half (observed on the calibration video)
    const sorted = [...judged].sort((a, b) => a - b);
    for(let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1] - 1;
        if(gap > 0 && gap <= AD_GAP_FILL)
            for(let w = sorted[i - 1] + 1; w < sorted[i]; w++)
                judged.add(w);
    }
    return stats.filter(s => judged.has(s.w));
}

// ---- Jev requests (calibrated wording; same quota as the quality filter) ----

const AD_CRITERIA = {
    true: ('This window is part of a sponsored ad read (口播广告/商单): a contiguous segment where the creator '
        + 'narrates promotional copy for a third-party brand or product - the sponsor introduction, product '
        + 'pitching and claims, usage instructions and ingredient explanations for the sponsor product, '
        + 'personal-recommendation framing (\'我自己也在用\' style), usage testimony, sales figures, '
        + 'discount/coupon/link calls to action, and the closing wrap-up that announces returning to the '
        + 'regular content. The whole span from sponsor intro to \'back to content\' is ONE ad read, even where '
        + 'it sounds like casual advice. Judge primarily from windows[i].subtitle_in_window (what is being said '
        + 'on screen); the danmaku audience reactions in windows[i].danmaku_sample (complaints about ad reads, '
        + 'templated product praise, welcome-back messages after skipping) are supporting evidence only.'),
    false: ('This window is the video\'s own editorial content: the creator\'s regular narration on the video '
        + 'topic, including discussing brands or products as subject matter (news about a marketing incident, '
        + 'product reviews, criticism). Only lean toward not-ad when the window is genuinely ambiguous between '
        + 'discussing a brand as topic versus pitching it; a window that is clearly mid-pitch for the sponsor '
        + 'product (claims, usage instructions, discount calls to action) is not a case of \'unsure\'.'),
};

const AD_LINE_CRITERIA = {
    true: ('This subtitle line is part of the sponsored ad read: promotional narration for the third-party '
        + 'product advertised in ad_context (product pitch, claims, usage instructions, testimony, sales '
        + 'figures, discount/coupon calls to action). The ad read is one contiguous segment: opening lines '
        + 'that announce the sponsor segment AND closing lines that wrap it up and announce the return to '
        + 'regular content (e.g. 好的/那么我们回到...) all belong to the ad read. Regular editorial content on '
        + 'the video topic does not.'),
    false: ('This subtitle line is the video\'s own editorial content, not sponsor copy. When genuinely unsure '
        + 'lean toward not-ad.'),
};

async function jev_with_retry(body: any, prio_s: number): Promise<any> {
    let answers: any = null;
    let last_retry_after = 0;
    for(let attempt = 0; attempt <= AD_RETRIES; attempt++) {
        if(attempt > 0)
            await new Promise<void>(resolve => setTimeout(resolve,
                Math.max(AD_RETRY_BASE_MS * Math.pow(2, attempt - 1), last_retry_after)));
        await rl_acquire(); // shared quota with the quality filter
        const sem = get_jev_semaphore();
        // +10000: never compete with the quality filter, which gates playback
        await sem.acquire(() => Math.abs(prio_s - current_playhead_s()) + 10000);
        try {
            const resp = await with_timeout(call_jev(body), 30000, null);
            answers = resp && resp.answers;
            if(!answers)
                throw new Error('jev: no answers');
            break;
        } catch(e: any) {
            if(e instanceof RetryableError && attempt < AD_RETRIES) {
                last_retry_after = e.retry_after_ms;
                continue;
            }
            throw e;
        } finally {
            sem.release();
        }
    }
    if(!answers)
        throw new Error('jev: no answers');
    return answers;
}

function build_screen_request(pack: WindowStat[]) {
    const ctx = get_video_ctx();
    const state: any = {
        video: {
            title: ctx.title || '',
            uploader: ctx.uploader || '',
            keywords: ctx.keywords || [],
            desc: (ctx.desc || '').slice(0, 300),
        },
        windows: pack.map((st, i) => ({
            i,
            w: st.w,
            time_range_seconds: st.lo_s + '~' + st.hi_s,
            subtitle_in_window: st.sub,
            danmaku_sample: st.danmaku_sample,
        })),
        stats_note: ('time_range_seconds = the window position in the video; each danmaku_sample item is a '
            + 'de-duplicated audience comment with count = how many people posted it and t_seconds = when it '
            + 'appears. subtitle_in_window is the transcript of what the creator says in this window.'),
    };
    const questions: any = {};
    pack.forEach((st, i) => {
        questions['win_' + i] = {
            type: 'noul',
            instructions: `Is windows[${i}] (time_range_seconds ${st.lo_s}~${st.hi_s}) part of a sponsored ad read for a third-party product, as opposed to the video's own editorial content?`,
            criteria: AD_CRITERIA,
        };
    });
    return {state, model: AD_MODEL, questions};
}

function build_line_request(edge_lines: {from: number, to: number, content: string}[], ad_context: string) {
    const ctx = get_video_ctx();
    const state: any = {
        video: {
            title: ctx.title || '',
            uploader: ctx.uploader || '',
            keywords: ctx.keywords || [],
            desc: (ctx.desc || '').slice(0, 300),
        },
        ad_context,
        lines: edge_lines.map((l, i) => ({i, from_seconds: l.from, text: l.content})),
        stats_note: ('ad_context = transcript of a detected sponsored ad segment; lines = subtitle lines near '
            + 'its boundary, with from_seconds = when each line is spoken.'),
    };
    const questions: any = {};
    edge_lines.forEach((l, i) => {
        questions['line_' + i] = {
            type: 'noul',
            instructions: `Is lines[${i}] (from_seconds ${l.from}) part of the sponsored ad read in ad_context?`,
            criteria: AD_LINE_CRITERIA,
        };
    });
    return {state, model: AD_MODEL, questions};
}

// ---- interval assembly & boundary refinement (code only) ----

async function refine_edge(kind: 'start' | 'end', coarse: number, ad_context: string): Promise<number | null> {
    const lines = get_subtitle_lines();
    if(!lines || !lines.length)
        return null;
    const edge_lines = lines.filter(l => l.from >= coarse - AD_EDGE_PAD_S && l.from < coarse + AD_EDGE_PAD_S);
    if(!edge_lines.length)
        return null;
    const answers = await jev_with_retry(build_line_request(edge_lines, ad_context), coarse);
    const is_ad = edge_lines.map((_, i) => answers['line_' + i] && answers['line_' + i].noul >= AD_LINE_THRESHOLD);
    let idx_first = is_ad.indexOf(true);
    let idx_last = is_ad.lastIndexOf(true);
    if(idx_first < 0)
        return null; // refinement disagrees with the coarse interval: keep coarse
    if(kind === 'start')
        return edge_lines[idx_first].from;
    return edge_lines[idx_last].to + 0.3; // land just after the last ad line
}

function danmaku_snap_fallback(kind: 'start' | 'end', coarse: number): number | null {
    // no subtitle: fall back to audience markers ("欢迎回来" pins the end,
    // complaints pin the start) within +-30s of the coarse edge
    const near = fed_danmaku.filter(d => Math.abs(d.t_ms / 1000 - coarse) <= 30);
    if(!near.length)
        return null;
    if(kind === 'end') {
        const welcomes = near.filter(d => AD_WELCOME_RE.test(d.text));
        if(welcomes.length)
            return welcomes[0].t_ms / 1000;
        return null;
    }
    const complaints = near.filter(d => AD_COMPLAINT_RE.test(d.text));
    if(complaints.length)
        return complaints[0].t_ms / 1000;
    return null;
}

// ---- persistent result cache (per cid; replays and reloads cost nothing) ----

async function load_cache(): Promise<any> {
    try {
        const st = await chrome.storage.local.get(AD_CACHE_KEY);
        return (st && st[AD_CACHE_KEY]) || {};
    } catch(e) {
        return {};
    }
}

async function save_cache(store: any) {
    try {
        const keys = Object.keys(store);
        if(keys.length > AD_CACHE_CAP) {
            keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
            for(const k of keys.slice(0, keys.length - AD_CACHE_CAP))
                delete store[k];
        }
        await chrome.storage.local.set({[AD_CACHE_KEY]: store});
    } catch(e) {}
}

// ---- the scan ----

async function perform_scan(cid: int, config: LocalizedConfig) {
    const t0 = Date.now();
    // edge-case bounds (settings): reads shorter than min_s are not worth a
    // jarring cut, and promotion covering most of the video means the ad IS
    // the content (dedicated sponsored / soft-ad videos), not an inserted ad
    const min_s = Math.max(5, config.AI_AD_SKIP_MIN_S || 10);
    const max_cover = Math.min(0.95, Math.max(0.3, config.AI_AD_SKIP_MAX_COVER || 0.6));
    refresh_video_ctx_from_dom();

    // cached result from an earlier visit: reuse, zero requests
    // (AI_AD_SKIP_CACHE off = rescan on every visit, keep nothing on disk)
    const use_cache = config.AI_AD_SKIP_CACHE !== false;
    const cache = use_cache ? await load_cache() : {};
    const hit = cache['' + cid];
    if(hit && hit.model === AD_MODEL && Date.now() - (hit.ts || 0) < AD_CACHE_TTL_MS) {
        intervals = (hit.intervals || []).map((iv: any) => ({...iv, skipped: false}));
        if(intervals.length)
            start_ui_watcher();
        console.debug(`pakku ad_skip: ${intervals.length} cached interval(s) for cid ${cid}`);
        return;
    }

    if(!await jev_ready()) {
        console.debug('pakku ad_skip: no API key, skipping scan');
        return;
    }

    // subtitle: uploader-provided tracks rank first in the background proxy
    const bvid = get_bvid_from_url();
    if(bvid)
        await ensure_subtitle('cid_' + cid, bvid, cid, 10000);

    const stats = build_window_stats();
    const candidates = pick_candidates(stats);
    const p_ad = new Map<int, number>();

    // pack candidates: <= AD_PACK_SPAN_S of subtitle range per request
    let packs: WindowStat[][] = [];
    let cur: WindowStat[] = [];
    for(const st of candidates) {
        if(cur.length && st.hi_s - cur[0].lo_s > AD_PACK_SPAN_S) {
            packs.push(cur);
            cur = [];
        }
        cur.push(st);
    }
    if(cur.length)
        packs.push(cur);

    for(const pack of packs) {
        const answers = await jev_with_retry(build_screen_request(pack), (pack[0].lo_s + pack[pack.length - 1].hi_s) / 2);
        pack.forEach((st, i) => {
            const p = answers['win_' + i] ? answers['win_' + i].noul : 0;
            p_ad.set(st.w, p);
        });
    }

    // merge judged-ad windows (bridge tiny unjudged holes), then refine edges
    const ad_windows = [...p_ad.entries()].filter(([, p]) => p >= AD_SCREEN_THRESHOLD)
        .map(([w]) => w).sort((a, b) => a - b);
    const lines = get_subtitle_lines();
    let out: AdInterval[] = [];
    let run: int[] = [];
    const flush_run = () => {
        if(!run.length)
            return;
        let lo = run[0] * AD_WINDOW_S;
        let hi = (run[run.length - 1] + 1) * AD_WINDOW_S;
        const conf = Math.min(...run.map(w => p_ad.get(w)!));
        out.push({start_s: lo, end_s: hi, conf, skipped: false});
        run = [];
    };
    for(let i = 0; i < ad_windows.length; i++) {
        const w = ad_windows[i];
        if(run.length && w - run[run.length - 1] - 1 <= AD_BRIDGE_GAP)
            run.push(w);
        else {
            flush_run();
            run = [w];
        }
    }
    flush_run();

    // per-interval boundary refinement (Jev line judgments; audience-marker fallback)
    for(const iv of out) {
        let refined = false;
        if(lines && lines.length) {
            const ad_context = slice_subtitle(iv.start_s + 5, iv.end_s - 5).slice(0, 900);
            try {
                const [rs, re] = await Promise.all([
                    refine_edge('start', iv.start_s, ad_context),
                    refine_edge('end', iv.end_s, ad_context),
                ]);
                // trust the line judgments for the bounds (bounded by AD_EDGE_PAD_S);
                // reads that come out shorter than min_s are dropped by the
                // duration filter below rather than half-refined here
                if(rs !== null && rs < iv.end_s) {
                    iv.start_s = rs;
                    refined = true;
                }
                if(re !== null && re > iv.start_s) {
                    iv.end_s = re;
                    refined = true;
                }
            } catch(e) {
                console.warn('pakku ad_skip: boundary refinement failed, keeping coarse bounds', e);
            }
        }
        if(!refined) {
            const snap_s = danmaku_snap_fallback('start', iv.start_s);
            const snap_e = danmaku_snap_fallback('end', iv.end_s);
            if(snap_s !== null && snap_s < iv.end_s)
                iv.start_s = snap_s;
            if(snap_e !== null && snap_e > iv.start_s)
                iv.end_s = snap_e;
        }
    }

    // drop noise: reads too short to be worth a cut, then the coverage guard —
    // if detected ads cover most of the video the promotion IS the content
    // (dedicated sponsored / soft-ad video), which is not an inserted ad
    out = out.filter(iv => iv.end_s - iv.start_s >= min_s);
    let dur_s = lines && lines.length ? lines[lines.length - 1].to : 0;
    if(fed_danmaku.length)
        dur_s = Math.max(dur_s, Math.max(...fed_danmaku.map(d => d.t_ms)) / 1000);
    const covered_ratio = dur_s > 0
        ? out.reduce((s, iv) => s + (iv.end_s - iv.start_s), 0) / dur_s : 0;
    let suppressed: string | undefined;
    if(dur_s > 0 && out.length && covered_ratio >= max_cover) {
        console.debug(`pakku ad_skip: ads cover ${Math.round(covered_ratio * 100)}% of the video, treating the promotion as the content`);
        out = [];
        suppressed = 'coverage';
    }

    intervals = out;
    if(use_cache) {
        cache['' + cid] = {bvid, model: AD_MODEL, ts: Date.now(), intervals: out.map(iv => ({
            start_s: iv.start_s, end_s: iv.end_s, conf: iv.conf,
        }))};
        await save_cache(cache);
    }
    if(intervals.length)
        start_ui_watcher();

    ai_log_append({
        type: 'ad_scan', ts: Date.now(), cid,
        windows_judged: p_ad.size, packs: packs.length,
        window_ps: [...p_ad.entries()].sort((a, b) => a[0] - b[0])
            .map(([w, p]) => [w * AD_WINDOW_S, Math.round(p * 100) / 100]),
        intervals: intervals.map(iv => ({
            start: Math.round(iv.start_s), end: Math.round(iv.end_s), conf: Math.round(iv.conf * 100) / 100,
        })),
        covered_ratio: Math.round(covered_ratio * 100) / 100,
        suppressed,
        api_ms: Date.now() - t0,
    });
    console.debug(`pakku ad_skip: scan done in ${Date.now() - t0}ms, ${intervals.length} interval(s)`, intervals);
}

// ---- prompt UI: top-center pill on the player, manual skip + optional auto-skip ----

function current_playhead_s(): number {
    try {
        const v = document.querySelector('video');
        return v ? v.currentTime : 0;
    } catch(e) {
        return 0;
    }
}

function fmt_time(s: number): string {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

let pill: HTMLElement | null = null;
let pill_shown_at = 0; // wall clock when the current pill appeared (TTL anchor)
let notice: HTMLElement | null = null;
let notice_timer: any = null;

function find_player_host(): HTMLElement | null {
    try {
        const video = document.querySelector('video');
        if(!video)
            return null;
        return (video.closest('.bpx-player-container, #bilibili-player, .bpx-player') as HTMLElement) || video.parentElement;
    } catch(e) {
        return null;
    }
}

function remove_pill() {
    if(pill) {
        try {
            pill.remove();
        } catch(e) {}
        pill = null;
    }
    pill_shown_at = 0;
}

function show_notice(text: string, undo_to: number | null) {
    if(typeof document === 'undefined')
        return;
    try {
        if(notice)
            notice.remove();
        const host = find_player_host();
        if(!host)
            return;
        if(getComputedStyle(host).position === 'static')
            host.style.position = 'relative';
        notice = document.createElement('div');
        notice.id = 'pakku-ad-skip-notice';
        notice.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:100000;'
            + 'background:rgba(0,0,0,.72);color:#fff;border-radius:16px;padding:6px 14px;font-size:13px;'
            + 'font-family:sans-serif;display:flex;align-items:center;gap:10px;user-select:none;';
        notice.innerHTML = `<span>${text}</span>` + (undo_to !== null
            ? `<a href="javascript:void(0)" style="color:#fb7299;cursor:pointer;text-decoration:none;">↩ 回到 ${fmt_time(undo_to)}</a>`
            : '');
        if(undo_to !== null) {
            (notice.querySelector('a') as HTMLElement).addEventListener('click', () => {
                seek_to(undo_to);
                hide_notice();
            });
        }
        host.appendChild(notice);
        if(notice_timer)
            clearTimeout(notice_timer);
        const note_s = (watch_config && typeof watch_config.AI_AD_SKIP_NOTE_S === 'number')
            ? watch_config.AI_AD_SKIP_NOTE_S : AD_NOTE_S;
        notice_timer = setTimeout(hide_notice, Math.max(2, note_s) * 1000);
    } catch(e) {}
}

function hide_notice() {
    if(notice_timer) {
        clearTimeout(notice_timer);
        notice_timer = null;
    }
    if(notice) {
        try {
            notice.remove();
        } catch(e) {}
        notice = null;
    }
}

function seek_to(t: number) {
    try {
        const v = document.querySelector('video') as HTMLVideoElement | null;
        if(v)
            v.currentTime = t;
    } catch(e) {}
}

function skip_interval(iv: AdInterval, reason: 'manual' | 'auto') {
    const was_start = iv.start_s;
    seek_to(iv.end_s);
    iv.skipped = true;
    remove_pill();
    show_notice(reason === 'auto'
        ? `已自动跳过口播广告（置信度 ${Math.round(iv.conf * 100)}%）`
        : '已跳过口播广告', was_start);
}

function ui_tick() {
    try {
        if(!intervals.length) {
            remove_pill();
            return;
        }
        const lead_s = (watch_config && typeof watch_config.AI_AD_SKIP_PROMPT_LEAD_S === 'number')
            ? watch_config.AI_AD_SKIP_PROMPT_LEAD_S : AD_PROMPT_LEAD_S;
        const ttl_s = (watch_config && typeof watch_config.AI_AD_SKIP_PROMPT_TTL_S === 'number')
            ? watch_config.AI_AD_SKIP_PROMPT_TTL_S : AD_PROMPT_TTL_S;
        const cur = current_playhead_s();
        // TTL expiry is reversible: once the playhead leaves the interval's
        // prompt range, re-arm so a later visit (e.g. dragging the progress
        // bar back) shows the prompt again. ✕ (dismissed) stays permanent.
        for(const iv of intervals)
            if(iv.timed_out && !iv.dismissed && (cur < iv.start_s - lead_s || cur >= iv.end_s))
                iv.timed_out = false;
        // a dismissed (✕) or timed-out interval stays quiet: no prompt AND no
        // auto-skip for it (timed-out only until re-armed above)
        const active = intervals.find(iv => !iv.dismissed && !iv.timed_out && cur >= iv.start_s - lead_s && cur < iv.end_s);
        if(!active) {
            remove_pill();
            return;
        }
        // the prompt only hangs for a limited window, then dismisses itself;
        // 0 = keep it until the ad is over (no timed_out flag is ever set)
        if(pill && ttl_s > 0 && Date.now() - pill_shown_at >= ttl_s * 1000) {
            active.timed_out = true;
            remove_pill();
            return;
        }
        // high-confidence auto-skip (fires once per interval, only while inside
        // the ad and with enough runway left for the seek to be meaningful)
        const auto_on = !!(watch_config && watch_config.AI_AD_SKIP && watch_config.AI_AD_SKIP_AUTO);
        const thr = (watch_config && typeof watch_config.AI_AD_SKIP_AUTO_THRESHOLD === 'number')
            ? watch_config.AI_AD_SKIP_AUTO_THRESHOLD : 0.9;
        if(auto_on && !active.skipped && active.conf >= thr && cur >= active.start_s && cur < active.end_s - 3) {
            skip_interval(active, 'auto');
            return;
        }
        if(active.skipped || typeof document === 'undefined')
            return;
        if(!pill) {
            const host = find_player_host();
            if(!host)
                return;
            if(getComputedStyle(host).position === 'static')
                host.style.position = 'relative';
            pill = document.createElement('div');
            pill.id = 'pakku-ad-skip';
            pill.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:100000;'
                + 'background:rgba(0,0,0,.72);color:#fff;border-radius:16px;padding:6px 6px 6px 14px;font-size:13px;'
                + 'font-family:sans-serif;display:flex;align-items:center;gap:10px;user-select:none;white-space:nowrap;';
            pill.innerHTML = `<span>检测到口播广告 ${fmt_time(active.start_s)}–${fmt_time(active.end_s)}</span>`
                + '<button style="background:#fb7299;color:#fff;border:none;border-radius:12px;padding:4px 12px;'
                + 'font-size:13px;cursor:pointer;">跳过广告</button>'
                + '<button class="pakku-ad-close" title="本次不再提示" style="background:transparent;border:none;'
                + 'color:rgba(255,255,255,.75);cursor:pointer;font-size:16px;line-height:1;padding:4px 8px;">✕</button>';
            pill_shown_at = Date.now();
            (pill.querySelector('button') as HTMLElement).addEventListener('click', () => {
                skip_interval(active, 'manual');
            });
            (pill.querySelector('button.pakku-ad-close') as HTMLElement).addEventListener('click', () => {
                active.dismissed = true;
                remove_pill();
            });
            host.appendChild(pill);
        }
    } catch(e) {
        // the prompt must never break playback
    }
}

function start_ui_watcher() {
    if(typeof document === 'undefined' || ui_timer)
        return;
    ui_timer = setInterval(ui_tick, 500);
}

// ---- cache clearing: the options page broadcasts pakku_ad_clear_cache ----
// (distinct from ai_filter's ai_clear_cache so the two buttons stay independent)
function ad_clear_caches() {
    intervals = [];
    remove_pill();
    try {
        chrome.storage.local.remove(AD_CACHE_KEY);
    } catch(e) {}
}

try {
    if(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage)
        chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
            if(msg && msg.type === 'pakku_ad_clear_cache') {
                ad_clear_caches();
                try { sendResponse({ok: true}); } catch(e) {}
            }
        });
} catch(e) {}
