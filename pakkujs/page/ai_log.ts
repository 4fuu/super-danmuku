// AI filter log viewer page (linked from the options page).

function id(x: string) {
    return document.getElementById(x)!;
}

function ai_log_get(): Promise<any[]> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'ai_log_get'}, (resp: any) => {
            if(chrome.runtime.lastError)
                return resolve([]);
            resolve((resp && resp.lines) || []);
        });
    });
}

function render(lines: any[]) {
    let view = id('log-view') as HTMLDivElement;
    let summary = id('summary');
    let empty = id('empty');
    summary.textContent = `${lines.length} 条记录`;
    if(!lines.length) {
        view.style.display = 'none';
        view.textContent = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    view.style.display = 'block';
    let out: string[] = [];
    for(let i = lines.length - 1; i >= 0; i--) {
        let r = lines[i];
        let ts = new Date(r.ts).toLocaleTimeString();
        if(r.type === 'seg') {
            out.push(`[${ts}] 分片${r.segidx} 「${r.title}」 窗口=${r.windows} 完成=${r.done}/${r.windows}${r.budget_hit ? '（超预算放行未判定）' : ''} 删刷屏=${r.del_spam} 淘汰=${r.del_ratio} 保留=${r.kept}/${r.total}${r.long_skipped ? ` 长文跳过=${r.long_skipped}` : ''} 耗时=${r.ship_ms}ms`);
        } else if(r.type === 'window') {
            out.push(`[${ts}] 分片${r.segidx} 窗口${r.window}s 候选=${r.cands} 删=${r.del_spam}+${r.del_ratio} ${r.api_ms}ms${r.error ? ' 错误: ' + r.error : ''}`);
            for(let c of r.detail || [])
                out.push(`    ${c.k === 0 ? '✗删' : c.k === 2 ? '↓汰' : '✓留'} p=${(c.p ?? 0).toFixed(2)} q=${c.s} ×${c.n} ${c.t}`);
        } else if(r.type === 'ad_scan') {
            let ivs = (r.intervals || []).map((iv: any) => `${iv.start}s~${iv.end}s@${(iv.conf ?? 0).toFixed(2)}`).join('，');
            out.push(`[${ts}] 广告扫描 cid=${r.cid} 判定窗口=${r.windows_judged} 请求=${r.packs} 区间=[${ivs || '无'}] ${r.api_ms}ms${r.error ? ' 错误: ' + r.error : ''}`);
        }
    }
    view.textContent = out.join('\n');
}

function refresh() {
    void ai_log_get().then(render);
}

id('refresh').addEventListener('click', refresh);
id('clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({type: 'ai_log_clear'}, () => void chrome.runtime.lastError);
    render([]);
});
id('export').addEventListener('click', () => {
    void ai_log_get().then((lines) => {
        let blob = new Blob([JSON.stringify({exported_at: new Date().toISOString(), records: lines}, null, 2)], {type: 'application/json'});
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'super-danmuku-ai-log.json';
        a.click();
        URL.revokeObjectURL(a.href);
    });
});

refresh();
