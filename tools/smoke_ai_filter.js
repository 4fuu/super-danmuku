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
global.chrome = {
    runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
            if(msg.type === 'jev_ready') return cb({ready: true});
            if(msg.type === 'bili_subtitle') {
                return cb({error: null, lines: [
                    {from: 0, to: 12, content: '大家好今天我们来看iPhone 18 Pro和Duo'},
                    {from: 12, to: 28, content: '先说说摄像头的变化'},
                    {from: 35, to: 60, content: '这段在讲电池续航'},
                ]});
            }
            if(msg.type === 'jev_call') {
                jev_calls.push(msg.body);
                const state = msg.body.state;
                const n = state.candidates.length;
                const answers = {};
                state.candidates.forEach((c, i) => {
                    // deterministic mock: texts containing 中/抽/奖 => spam 0.9, else 0.05; quality low for spam
                    const is_spam = /[中抽奖许愿]/.test(c.text);
                    answers['worst_' + i] = {type: 'noul', noul: is_spam ? 0.9 : 0.05};
                    answers['qual_' + i] = {type: 'score', score: is_spam ? 0.1 : 2.5};
                });
                cb({error: null, data: {answers, usage: {input_tokens: 1000}}});
            } else {
                cb(null);
            }
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

(async () => {
    // window 0-30s: spam + good mix; window 40-70s: small (2 objs -> skipped); window 100-130s: only good
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
    };

    const t0 = Date.now();
    const res = await mod.ai_filter_chunk(chunk, config, 1);
    const dt = Date.now() - t0;

    console.log(`elapsed ${dt}ms, windows=${res.ai_windows}, deleted(spam)=${res.ai_deleted}, deleted(ratio)=${res.ai_deleted_ratio}`);
    console.log('jev requests made:', jev_calls.length);
    for(const call of jev_calls)
        console.log('  window:', call.state.danmaku_window.time_range_seconds, 'candidates:', call.state.candidates.length, 'title:', call.state.video.title);
    console.log('kept:');
    for(const o of res.chunk.objs)
        console.log('  ', o.content);

    // assertions
    const kept = new Set(res.chunk.objs.map(o => o.content));
    const assert = (cond, msg) => { if(!cond) { console.error('FAIL:', msg); process.exit(1); } };
    assert(jev_calls.length === 2, 'two windows scored (tiny window skipped)');
    // subtitle context must be present and sliced to the window range
    const w0 = jev_calls.find(c => c.state.danmaku_window.time_range_seconds === '0~30');
    assert(w0 && w0.state.danmaku_window.subtitle_in_window.includes('摄像头'), 'window 0~30s subtitle slice includes camera line');
    assert(!w0.state.danmaku_window.subtitle_in_window.includes('电池续航'), 'window 0~30s excludes later subtitle');
    const w2 = jev_calls.find(c => c.state.danmaku_window.time_range_seconds === '90~120');
    assert(w2 && w2.state.danmaku_window.subtitle_in_window === '', 'window 90~120s has no subtitle (past 60s)');
    assert(res.ai_deleted === 590, `raw deleted count sums peers (got ${res.ai_deleted})`);
    assert(!kept.has('中中中') && !kept.has('抽我抽我') && !kept.has('求中奖'), 'spam deleted by threshold');
    assert(kept.has('居然有6级的防尘？') && kept.has('这是iOS，想都别想'), 'good kept');
    assert(kept.has('支持') && kept.has('牛'), 'tiny window untouched');
    // ratio layer: window 0 had 4 survivors (无限进步, 防尘, iOS, 哈哈哈), floor(4*0.2)=0 -> no ratio deletion
    assert(res.ai_deleted_ratio === 0, 'ratio deletes 0 when floor(n*ratio)=0');
    // window 2: 4 good survivors -> floor(4*0.2)=0 -> all kept
    assert(kept.has('这不是pura x max 都有的功能吗'), 'good-only window kept');

    // rerun -> cache hit (no new jev calls)
    const calls_before = jev_calls.length;
    const res2 = await mod.ai_filter_chunk(chunk, config, 1);
    assert(jev_calls.length === calls_before, 'cache prevents re-scoring');
    assert(res2.chunk.objs.length === res.chunk.objs.length, 'cache gives same result');

    console.log('ALL ASSERTIONS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
