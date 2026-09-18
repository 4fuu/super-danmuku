// Smoke test for ai_filter core logic with mocked chrome + Jev.
// locate the compiled ai_filter.js under dist/ts_cache (path mirrors the build machine layout)
const fs = require('fs'), path = require('path');
function find_compiled(dir) {
    const stack = [dir];
    while(stack.length) {
        const cur = stack.pop();
        for(const e of fs.readdirSync(cur, {withFileTypes: true})) {
            const p = path.join(cur, e.name);
            if(e.isDirectory()) stack.push(p);
            else if(e.name === 'ai_filter.js' && cur.split(path.sep).includes('core')) return p;
        }
    }
    throw new Error('compiled ai_filter.js not found under ' + dir + ' — run `npm run build:chrome` first');
}
const mod = require(find_compiled(path.resolve(__dirname, '../dist')));

// ---- mocks ----
let jev_responses = [];
let jev_calls = [];
let jev_delay_ms = 0; // adjustable per scenario
let inflight = 0, max_inflight = 0;
let ai_log_msgs = [];
let reload_requests = [];
let retry_fails_remaining = {}; // window range -> remaining 429s to inject
const storage_data = {};
global.chrome = {
    runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
            if(msg.type === 'jev_ready') return cb({ready: true});
            if(msg.type === 'ai_log_append') { ai_log_msgs.push(msg.rec); return cb({ok: true}); }
            if(msg.type === 'ai_log_get') return cb({lines: ai_log_msgs});
            if(msg.type === 'ai_request_reload') { reload_requests.push(Date.now()); return cb({ok: true}); }
            if(msg.type === 'bili_subtitle') {
                return cb({error: null, lines: [
                    {from: 0, to: 12, content: '大家好今天我们来看iPhone 18 Pro和Duo'},
                    {from: 12, to: 28, content: '先说说摄像头的变化'},
                    {from: 31, to: 45, content: '字幕填充探针行'}, // only visible when subtitle padding reaches past 30s
                    {from: 35, to: 60, content: '这段在讲电池续航'},
                ]});
            }
            if(msg.type === 'jev_call') {
                jev_calls.push(msg.body);
                inflight++;
                max_inflight = Math.max(max_inflight, inflight);
                setTimeout(() => {
                    inflight--;
                    // inject 429s for windows whose first candidate is marked 限流
                    const first = msg.body.state.candidates[0];
                    if(first && first.text.startsWith('限流')) {
                        const wkey = msg.body.state.danmaku_window.time_range_seconds;
                        retry_fails_remaining[wkey] = retry_fails_remaining[wkey] || 0;
                        if(retry_fails_remaining[wkey] < 2) {
                            retry_fails_remaining[wkey]++;
                            return cb({error: 'Jev API busy (429)', retryable: true, retry_after_ms: 0});
                        }
                    }
                    const state = msg.body.state;
                    const answers = {};
                    state.candidates.forEach((c, i) => {
                        // deterministic mock: texts containing 中/抽/奖 => spam 0.9, else 0.05; quality low for spam
                        const is_spam = /[中抽奖许愿]/.test(c.text);
                        answers['worst_' + i] = {type: 'noul', noul: is_spam ? 0.9 : 0.05};
                        answers['qual_' + i] = {type: 'score', score: is_spam ? 0.1 : 2.5};
                    });
                    cb({error: null, data: {answers, usage: {input_tokens: 1000}}});
                }, jev_delay_ms);
            } else {
                cb(null);
            }
        },
    },
    storage: {
        local: {
            get: (k, cb) => {
                const r = {};
                if(typeof k === 'string')
                    r[k] = storage_data[k];
                else if(Array.isArray(k))
                    k.forEach(x => r[x] = storage_data[x]);
                else
                    Object.assign(r, storage_data);
                setTimeout(() => cb(r), 0);
            },
            set: (obj, cb) => { Object.assign(storage_data, obj); if(cb) cb(); },
            remove: (k, cb) => { delete storage_data[k]; if(cb) cb(); },
        },
    },
};
global.document = {
    title: '选哪个？iPhone 18 Pro&Duo深度上手_哔哩哔哩_bilibili',
    querySelector: () => null,
};
global.location = {pathname: '/video/BV1cSec6tEux/'};

function mkobj(time_ms, content, peers_n) {
    const peers = [];
    for(let i = 0; i < peers_n; i++)
        peers.push({time_ms: time_ms + i * 700, content, sim_reason: '=='});
    return {
        time_ms, mode: 1, fontsize: 25, color: 16777215, sender_hash: 'x', content,
        sendtime: 0, weight: 3, id: '1', pool: 0, extra: {proto_oid: 41969257534},
        pakku: {peers, desc: [], disp_str: content},
    };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if(!cond) { console.error('FAIL:', msg); process.exit(1); } };

(async () => {
    // ===== scenario 1: correctness (30s windows, padding on, immediate responses) =====
    const objs = [
        mkobj(1000, '中中中', 500),
        mkobj(2000, '抽我抽我', 60),
        mkobj(3000, '求中奖', 30),
        mkobj(4000, '无限进步', 40),
        mkobj(5000, '居然有6级的防尘？', 1),
        mkobj(6000, '哈哈哈', 20),
        mkobj(7000, '这是iOS，想都别想', 1),
        // separate tiny window
        mkobj(45000, '支持', 2),
        mkobj(46000, '牛', 1),
        // another window: only good
        mkobj(101000, '这不是pura x max 都有的功能吗', 1),
        mkobj(102000, '有我的888烫吗？', 1),
        mkobj(103000, '0人提到加拿大品牌', 1),
        mkobj(104000, '来了', 3),
    ];
    const chunk = {objs, extra: {proto_segidx: 1}};

    const config = {
        AI_FILTER: true, AI_API_KEY: 'test', AI_DELETE_THRESHOLD: 0.6,
        AI_RATIO: 0.2, AI_WINDOW_SECONDS: 30, AI_MAX_CANDIDATES: 50,
        AI_SUBTITLE_PADDING_SECONDS: 5, AI_CONCURRENCY: 4, AI_BUDGET_MS: 6000,
        AI_PAUSE_GATE: false, // gate needs a real <video>; exercised manually
        AI_VERDICT_CACHE: true, // scenario 5 covers the persistence path explicitly
        AI_MAX_TEXT_LEN: 40, // scenarios 1-7 assume long texts are judged; scenario 8 tests the limit itself
    };

    const res = await mod.ai_filter_chunk(chunk, config, 1);

    console.log(`scenario1: windows=${res.ai_windows}, deleted(spam)=${res.ai_deleted}, deleted(ratio)=${res.ai_deleted_ratio}`);
    for(const call of jev_calls)
        console.log('  window:', call.state.danmaku_window.time_range_seconds, 'candidates:', call.state.candidates.length);

    const kept = new Set(res.chunk.objs.map(o => o.content));
    assert(jev_calls.length === 2, 'two windows scored (tiny window skipped)');
    // subtitle context must be present, sliced to the padded window range
    const w0 = jev_calls.find(c => c.state.danmaku_window.time_range_seconds === '0~30');
    assert(w0 && w0.state.danmaku_window.subtitle_in_window.includes('摄像头'), 'window 0~30s subtitle slice includes camera line');
    assert(w0 && w0.state.danmaku_window.subtitle_in_window.includes('字幕填充探针行'), 'subtitle padding pulls the 31-45s line into window 0~30s');
    assert(w0 && !w0.state.danmaku_window.subtitle_in_window.includes('电池续航'), 'window 0~30s excludes later subtitle');
    const w2 = jev_calls.find(c => c.state.danmaku_window.time_range_seconds === '90~120');
    assert(w2 && w2.state.danmaku_window.subtitle_in_window === '', 'window 90~120s has no subtitle (past 60s)');
    assert(res.ai_deleted === 590, `raw deleted count sums peers (got ${res.ai_deleted})`);
    assert(!kept.has('中中中') && !kept.has('抽我抽我') && !kept.has('求中奖'), 'spam deleted by threshold');
    assert(kept.has('居然有6级的防尘？') && kept.has('这是iOS，想都别想'), 'good kept');
    assert(kept.has('支持') && kept.has('牛'), 'tiny window untouched');
    assert(res.ai_deleted_ratio === 0, 'ratio deletes 0 when floor(n*ratio)=0');
    assert(kept.has('这不是pura x max 都有的功能吗'), 'good-only window kept');
    assert(ai_log_msgs.some(m => m.type === 'window'), 'per-window log records emitted');
    assert(ai_log_msgs.some(m => m.type === 'seg'), 'per-segment log record emitted');

    // rerun -> cache hit (no new jev calls)
    const calls_before = jev_calls.length;
    const res2 = await mod.ai_filter_chunk(chunk, config, 1);
    assert(jev_calls.length === calls_before, 'cache prevents re-scoring');
    assert(res2.chunk.objs.length === res.chunk.objs.length, 'cache gives same result');

    // ===== scenario 2: budget ships early, background scoring warms the cache =====
    jev_calls = [];
    jev_delay_ms = 300;
    const objs2 = [];
    for(let w = 0; w < 4; w++)
        for(let i = 0; i < 4; i++)
            objs2.push(mkobj(w * 30000 + i * 1000, `正常弹幕${w}-${i}`, 1));
    const chunk2 = {objs: objs2, extra: {proto_segidx: 2}};
    const cfg2 = {...config, AI_CONCURRENCY: 1, AI_BUDGET_MS: 500};

    const t2 = Date.now();
    const res2b = await mod.ai_filter_chunk(chunk2, cfg2, 2);
    const dt2 = Date.now() - t2;
    console.log(`scenario2: shipped in ${dt2}ms with ${jev_calls.length} calls made at ship`);
    // concurrency=1 and 4 windows x 300ms => full run needs 1200ms; budget must ship at ~500ms
    assert(dt2 >= 450 && dt2 < 900, `budget ships early (elapsed ${dt2}ms, full run would be 1200ms)`);
    assert(res2b.chunk.objs.length === objs2.length, 'nothing deleted while unjudged (all good texts)');

    await sleep(900); // let the background scoring finish
    assert(jev_calls.length === 4, `background scoring completes all windows (got ${jev_calls.length})`);

    // reload -> fully cached, instant
    jev_calls = [];
    const t2c = Date.now();
    const res2c = await mod.ai_filter_chunk(chunk2, cfg2, 2);
    const dt2c = Date.now() - t2c;
    console.log(`scenario2 reload: ${dt2c}ms, calls=${jev_calls.length}`);
    assert(jev_calls.length === 0, 'warm cache: reload makes zero requests');
    assert(dt2c < 200, 'warm cache: reload is instant');

    // ===== scenario 3: concurrency limit =====
    jev_calls = [];
    max_inflight = 0;
    jev_delay_ms = 80;
    const objs3 = [];
    for(let w = 0; w < 6; w++)
        for(let i = 0; i < 3; i++)
            objs3.push(mkobj(w * 30000 + i * 1000, `并发测试${w}-${i}`, 1));
    const cfg3 = {...config, AI_CONCURRENCY: 2, AI_BUDGET_MS: 20000};
    const res3 = await mod.ai_filter_chunk({objs: objs3, extra: {proto_segidx: 3}}, cfg3, 3);
    console.log(`scenario3: windows=${res3.ai_windows} calls=${jev_calls.length} max_inflight=${max_inflight}`);
    assert(jev_calls.length === 6, 'all six windows scored');
    assert(max_inflight <= 2, `concurrency limit respected (max_inflight=${max_inflight})`);

    // ===== scenario 4: 429 exponential backoff retries, then success =====
    jev_calls = [];
    jev_delay_ms = 0;
    const objs4 = [
        mkobj(1000, '限流测试中奖', 5),
        mkobj(2000, '限流测试抽奖', 5),
        mkobj(3000, '限流测试必中', 5),
    ];
    const cfg4 = {...config, AI_BUDGET_MS: 6000};
    const t4 = Date.now();
    const res4 = await mod.ai_filter_chunk({objs: objs4, extra: {proto_segidx: 4}}, cfg4, 4);
    const dt4 = Date.now() - t4;
    console.log(`scenario4: calls=${jev_calls.length} elapsed=${dt4}ms kept=${res4.chunk.objs.length}`);
    assert(jev_calls.length === 3, 'window retried twice then succeeded (3 attempts)');
    assert(dt4 >= 1400, `backoff delays applied (500+1000ms, elapsed ${dt4}ms)`);
    assert(res4.chunk.objs.length === 0, 'spam deleted after successful retry');

    // ===== scenario 5: persistent verdict cache reused across loads =====
    jev_calls = [];
    // 5a: first visit scores and persists verdicts
    const objs5a = [
        mkobj(1000, '持久验证中签', 3),
        mkobj(2000, '持久验证抽我', 3),
        mkobj(3000, '持久验证许愿', 3),
    ];
    await mod.ai_filter_chunk({objs: objs5a, extra: {proto_segidx: 5}}, config, 5);
    assert(jev_calls.length === 1, 'first visit makes one request');
    assert(storage_data['ai_verdicts'] && storage_data['ai_verdicts']['41969257534|0|持久验证中签'], 'verdict persisted to storage with score/model/time');
    const persisted = storage_data['ai_verdicts']['41969257534|0|持久验证中签'];
    assert(typeof persisted.p === 'number' && typeof persisted.s === 'number' && persisted.m === 'jev-latest' && typeof persisted.t === 'number', 'verdict entry has score, model, timestamp');
    // 5b: reload with a different chunk shape (L1 misses) but same texts/windows -> verdict reuse, zero requests
    jev_calls = [];
    const t5 = Date.now();
    const objs5b = [
        mkobj(1000, '持久验证中签', 3),
        mkobj(2000, '持久验证抽我', 3),
        mkobj(3000, '持久验证许愿', 3),
        // extra objects in a later window change the chunk shape (fresh L1 cache key)
        mkobj(101000, '新增的无关弹幕甲', 1),
        mkobj(102000, '新增的无关弹幕乙', 1),
        mkobj(103000, '新增的无关弹幕丙', 1),
    ];
    const res5 = await mod.ai_filter_chunk({objs: objs5b, extra: {proto_segidx: 6}}, config, 6);
    console.log(`scenario5: reload calls=${jev_calls.length} elapsed=${Date.now() - t5}ms kept=${res5.chunk.objs.length}`);
    assert(jev_calls.length === 1, 'verdict cache: only the unseen window requests (1 call)');
    const kept5 = new Set(res5.chunk.objs.map(o => o.content));
    assert(!kept5.has('持久验证中签') && !kept5.has('持久验证抽我'), 'cached verdicts applied instantly on reload');
    assert(kept5.has('新增的无关弹幕甲'), 'new window still scored');

    // ===== scenario 6: zero budget ships instantly (safety valve fully open) =====
    jev_calls = [];
    reload_requests = [];
    jev_delay_ms = 60;
    const objs6 = [];
    for(let w = 0; w < 2; w++)
        for(let i = 0; i < 3; i++)
            objs6.push(mkobj(w * 30000 + i * 1000, `追溯屏蔽中${w}-${i}`, 4));
    const cfg6 = {...config, AI_BUDGET_MS: 0, AI_CONCURRENCY: 1}; // ship instantly, score later
    const t6 = Date.now();
    const res6 = await mod.ai_filter_chunk({objs: objs6, extra: {proto_segidx: 7}}, cfg6, 7);
    const dt6 = Date.now() - t6;
    console.log(`scenario6: shipped in ${dt6}ms unfiltered=${res6.chunk.objs.length}`);
    assert(dt6 < 50, `zero budget ships instantly without waiting (elapsed ${dt6}ms)`);
    assert(res6.chunk.objs.length === objs6.length, 'nothing deleted at ship time (no delay)');
    await sleep(600); // background pass completes
    assert(reload_requests.length === 0, 'no player reload requests (mechanism removed)');

    // ===== scenario 7: full scoring before shipping (default behavior) =====
    jev_calls = [];
    jev_delay_ms = 100;
    const objs7 = [];
    for(let w = 0; w < 3; w++)
        for(let i = 0; i < 3; i++)
            objs7.push(mkobj(w * 30000 + i * 1000, `全量判定中${w}-${i}`, 2));
    const cfg7 = {...config, AI_BUDGET_MS: 60000, AI_CONCURRENCY: 8};
    const t7 = Date.now();
    const res7 = await mod.ai_filter_chunk({objs: objs7, extra: {proto_segidx: 8}}, cfg7, 8);
    const dt7 = Date.now() - t7;
    console.log(`scenario7: shipped in ${dt7}ms deleted=${res7.ai_deleted} kept=${res7.chunk.objs.length}`);
    assert(dt7 >= 90, `response waits for full scoring (elapsed ${dt7}ms >= 100ms of API latency)`);
    assert(res7.chunk.objs.length === 0 && res7.ai_deleted === 18, `everything filtered before shipping (deleted ${res7.ai_deleted})`);

    // ===== scenario 8: length limit skips judgement, passes through =====
    jev_calls = [];
    jev_delay_ms = 0;
    const cfg8 = {...config, AI_MAX_TEXT_LEN: 5};
    const long_spam = '中'.repeat(60); // far over the limit -> pass through
    const six_spam = '六个字的刷中'; // 6 chars, over the limit of 5 -> pass through
    const objs8 = [
        mkobj(1000, long_spam, 10),
        mkobj(1500, six_spam, 6),
        mkobj(2000, '字数限中', 3),
        mkobj(3000, '字数限抽', 3),
        mkobj(4000, '字数限奖', 3),
    ];
    const res8 = await mod.ai_filter_chunk({objs: objs8, extra: {proto_segidx: 9}}, cfg8, 9);
    const kept8 = new Set(res8.chunk.objs.map(o => o.content));
    const req_cands = jev_calls.flatMap(c => c.state.candidates.map(x => x.text));
    console.log(`scenario8: kept=${[...kept8].join('/')} request_cands=${req_cands.length}`);
    assert(kept8.has(long_spam) && kept8.has(six_spam), 'over-limit danmaku passes through without judgement');
    assert(!kept8.has('字数限中') && !kept8.has('字数限抽') && !kept8.has('字数限奖'), 'short spam still deleted');
    assert(jev_calls.length === 1, 'one request for the eligible short candidates');
    assert(!req_cands.includes(long_spam) && !req_cands.includes(six_spam), 'over-limit danmaku never sent to the API');
    const seg_log_8 = ai_log_msgs.filter(m => m.type === 'seg' && m.segidx === 9).pop();
    assert(seg_log_8 && seg_log_8.long_skipped === 2, 'long_skipped counted in segment log');

    // ===== scenario 9: gate pauses for real pending windows, never for the coverage edge =====
    jev_calls = [];
    jev_delay_ms = 0;
    const fake_video = {
        currentTime: 29.5, paused: false,
        pause_calls: 0, play_calls: 0,
        pause() { this.paused = true; this.pause_calls++; },
        play() { this.paused = false; this.play_calls++; return Promise.resolve(); },
        closest: () => null, parentElement: null, // no overlay host -> overlay no-op in the mock
    };
    global.document.querySelector = (sel) => sel === 'video' ? fake_video : null;
    global.document.body = true;
    global.document.getElementById = () => null;
    global.document.createElement = () => ({style: {}, id: '', textContent: '', innerHTML: '', appendChild() {}, remove() {}, querySelector: () => null});
    global.document.head = {appendChild() {}};

    const cfg9 = {...config, AI_PAUSE_GATE: true, AI_PAUSE_MARGIN_S: 5, AI_WINDOW_SECONDS: 5};
    // chunk covering 0~30s, all windows score instantly; the playhead at 29.5s sits
    // exactly at the edge of loaded coverage — this must NOT pause (deadlock fix)
    const objs9 = [];
    for(let t = 0; t < 30; t += 5)
        objs9.push(mkobj(t * 1000 + 500, '边缘场景弹幕', 4));
    await mod.ai_filter_chunk({objs: objs9, extra: {proto_segidx: 11}}, cfg9, 11);
    await sleep(1200); // gate ticks run with every window done
    console.log(`scenario9a: edge-only pause_calls=${fake_video.pause_calls}`);
    assert(fake_video.pause_calls === 0 && !fake_video.paused, 'coverage edge alone must not pause playback');

    // a chunk whose windows overlap the playhead while scoring is slow: must pause, then resume
    jev_delay_ms = 1500;
    const objs9b = [];
    for(let t = 30; t < 45; t += 5) { // 3 candidates per window so they actually register as pending
        objs9b.push(mkobj(t * 1000 + 500, '慢速窗口弹幕一', 4));
        objs9b.push(mkobj(t * 1000 + 1200, '慢速窗口弹幕二', 4));
        objs9b.push(mkobj(t * 1000 + 1900, '慢速窗口弹幕三', 4));
    }
    await mod.ai_filter_chunk({objs: objs9b, extra: {proto_segidx: 12}}, cfg9, 12);
    await sleep(1000); // next tick notices the windows are done and resumes
    console.log(`scenario9b: pause_calls=${fake_video.pause_calls} play_calls=${fake_video.play_calls} paused=${fake_video.paused}`);
    assert(fake_video.pause_calls >= 1, 'pending windows near the playhead still pause playback');
    assert(fake_video.play_calls >= 1 && !fake_video.paused, 'playback resumes once the windows are scored');
    global.document.querySelector = () => null; // stop gating the mock video

    // ===== scenario 10: priority scheduling follows the playhead, not task order =====
    jev_calls = [];
    jev_delay_ms = 300;
    const call_order = [];
    const orig_send = global.chrome.runtime.sendMessage;
    global.chrome.runtime.sendMessage = (msg, cb) => {
        if(msg.type === 'jev_call') {
            call_order.push(msg.body.state.danmaku_window.time_range_seconds);
        }
        return orig_send(msg, cb);
    };
    // seg A covers 0~6min (playhead sits at 0:29.5 inside it), seg B covers 6~12min;
    // B is processed FIRST (simulating a later segment finishing combine first).
    // With concurrency 4 and all of B queued ahead of A, the playhead-adjacent
    // windows of A must still be among the first requests sent.
    const cfg10 = {...config, AI_CONCURRENCY: 4, AI_WINDOW_SECONDS: 30, AI_PAUSE_GATE: false};
    const mk_windows = (base_s, tag) => {
        const objs = [];
        for(let t = 0; t < 3600; t += 30) { // 120 windows, 3 cands each
            objs.push(mkobj((base_s + t + 1) * 1000, tag + '甲', 3));
            objs.push(mkobj((base_s + t + 6) * 1000, tag + '乙', 3));
            objs.push(mkobj((base_s + t + 11) * 1000, tag + '丙', 3));
        }
        return objs;
    };
    const segB = mk_windows(3600, '后');
    const segA = mk_windows(0, '前');
    // fire both; B first (its tasks enter the semaphore queue first)
    void mod.ai_filter_chunk({objs: segB, extra: {proto_segidx: 21}}, cfg10, 21);
    await mod.ai_filter_chunk({objs: segA, extra: {proto_segidx: 20}}, cfg10, 20);
    await sleep(200);
    global.chrome.runtime.sendMessage = orig_send;
    console.log(`scenario10: first 8 windows sent: ${call_order.slice(0, 8).join(', ')}`);
    assert(call_order.length >= 8, 'requests were sent');
    const early = call_order.slice(0, 8).filter(x => x === '0~30' || x === '30~60' || x === '60~90');
    assert(early.length >= 3, `playhead-adjacent windows are sent early (got [${call_order.slice(0, 8).join(', ')}])`);

    console.log('ALL ASSERTIONS PASSED');
    process.exit(0); // the gate's poll timer would otherwise hold the process open
})().catch(e => { console.error(e); process.exit(1); });
