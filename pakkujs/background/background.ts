import {install_dnr_rule} from "./danmu_update_blocker";
import {get_config, hotfix_on_update, save_config} from "./config";
import {get_state, HAS_SESSION_STORAGE, init_state, save_state} from "./state";
import {LocalizedConfig} from "../core/types";
import {is_permission_buggy, do_fix_permission} from './permission_check';

// cid -> subtitle lines [{from, to, content}] (seconds); empty array = video has no subtitle
const subtitle_cache = new Map<number, any[]>();

// AI filter diagnostic log (bounded, persisted tail; viewable/exportable from the options page).
// Contains danmaku texts and verdicts only — never the API key.
const AI_LOG_MAX = 300;
let ai_log_lines: any[] = [];
chrome.storage.local.get('ai_log', (st: any) => {
    ai_log_lines = st.ai_log || [];
});
function ai_log_push(rec: any) {
    ai_log_lines.push(rec);
    if(ai_log_lines.length > AI_LOG_MAX)
        ai_log_lines = ai_log_lines.slice(-AI_LOG_MAX);
    void chrome.storage.local.set({ai_log: ai_log_lines});
}

async function check_fix_permission() {
    let perms = await chrome.permissions.getAll();

    if(is_permission_buggy(perms)) {
        chrome.notifications.create('//perm_hotfix', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('/assets/logo.png'),
            title: '请授予 super-danmuku 权限',
            message: 'super-danmuku 目前没有修改弹幕所需的权限，无法正常工作。点击修复权限。',

            // xxx: firefox does not support requireInteraction and buttons
            ...process.env.PAKKU_CHANNEL==='firefox' ? {} : {
                requireInteraction: true,
                buttons: [
                    {title: '立即修复'},
                ],
            },
        });
    }
}

chrome.notifications.onClicked.addListener(async function(notif_id) {
    if(notif_id==='//perm_hotfix') {
        // xxx: we cannot load config.BREAK_UPDATE here because async breaks user gesture
        await do_fix_permission(false, true);
    }
});
chrome.notifications.onButtonClicked.addListener(async function(notif_id,btn_idx) {
    if(notif_id==='//perm_hotfix') {
        // xxx: we cannot load config.BREAK_UPDATE here because async breaks user gesture
        await do_fix_permission(false, true);
    }
});

const DEFAULT_BADGE_BGCOLOR = '#26c';

async function reset_badge() {
    // reset badge options because options during the previous launch might not be cleared away
    await chrome.action.setBadgeText({text: ''});
    await chrome.action.setBadgeBackgroundColor({color: DEFAULT_BADGE_BGCOLOR});
    if(chrome.action.setBadgeTextColor)
        await chrome.action.setBadgeTextColor({color: 'white'});
}

async function install_context_menu() {
    chrome.contextMenus.removeAll(()=>{
        chrome.contextMenus.create({
            id: 'toggle-global-switch',
            title: '切换工作状态',
            contexts: ['action'],
        });
        chrome.contextMenus.create({
            id: 'show-local',
            title: '处理本地弹幕',
            contexts: ['action'],
        });
    });
}

async function install_content_script() {
    let installed = await chrome.scripting.getRegisteredContentScripts({
        ids: ['pakku-ajax'],
    });
    if(installed.length>0)
        return;

    let shared_args = {
        id: 'pakku-ajax',
        allFrames: true,
        matches: ['*://*.bilibili.com/*'],
        excludeMatches: [
            'https://www.bilibili.com/robots.txt?pakku_sandbox', // no need and may cause var name conflict
            'https://message.bilibili.com/*', // no need and may reduce performance due to iframes in the player page
        ],
        css: ['/generated/injected.css'],
        runAt: 'document_start' as 'document_start',
    };

    try {
        await chrome.scripting.registerContentScripts([{
            ...shared_args,
            js: ['/generated/xhr_hook.js'],
            world: 'MAIN',
        }]);
        console.log('pakku ajax: installed content script');
    } catch(e) { // no `world` arg for firefox and chrome <102
        await chrome.scripting.registerContentScripts([{
            ...shared_args,
            js: ['/assets/xhr_hook_injector.js'],
        }]);
        console.log('pakku ajax: installed content script (FALLBACK)');
    }
}

async function perform_init() {
    let is_init = await init_state();
    if(is_init) {
        await reset_badge();
        await check_fix_permission();
    }
}
void perform_init();

async function toggle_global_switch() {
    let new_switch = !(await get_state()).GLOBAL_SWITCH;
    await save_state({
        GLOBAL_SWITCH: new_switch,
    });
    await chrome.action.setBadgeText({
        text: new_switch ? '' : 'zzz',
    });

    // notify popup and content scripts
    chrome.runtime.sendMessage({type: 'reload_popup_state', tabid: null})
        .catch(()=>{});
    let cur_tabid = (await chrome.tabs.query({active: true, currentWindow: true}))[0]?.id || null;
    for(let tab of await chrome.tabs.query({})) {
        let url = tab.url;
        if(url?.includes('bilibili.com/'))
            chrome.tabs.sendMessage(tab.id!, {type: 'reload_danmu', key: new_switch ? 2 : 1, trigger_player: (tab.id===cur_tabid)})
                .catch(()=>{});
    }

    return new_switch;
}

function install_declarative_stuff() {
    // best practice to re-install all declarative stuff on every startup
    // https://groups.google.com/a/chromium.org/g/chromium-extensions/c/ZM0Vzb_vuIs/m/Nm4gK-X0AQAJ

    void install_dnr_rule();
    void install_context_menu();
    void install_content_script();
}

chrome.runtime.onStartup.addListener(async ()=>{
    install_declarative_stuff();

    if(!HAS_SESSION_STORAGE) {
        console.error('pakku state: EMULATING session storage');
        await chrome.storage.local.clear();
        // redo the init since the state is reset
        await perform_init();
    }
});

chrome.runtime.onInstalled.addListener(async (details)=>{
    install_declarative_stuff();

    if(details.reason==='install') {
        void chrome.tabs.create({url: chrome.runtime.getURL('page/options.html')});
    }

    if(details.reason==='update') {
        console.log('pakku config: try to migrate');
        let config = await get_config();
        hotfix_on_update(config);
        await save_config(config);
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if(msg.type==='get_local_config') {
        async function worker() {
            let is_pure_env = msg.is_pure_env;

            let tabid = sender.tab?.id;
            let config = await get_config();
            let state = await get_state();

            let userscript = config.USERSCRIPT || '';
            if(state[`USERSCRIPT_${tabid}`])
                userscript = userscript + '\n\n' + state[`USERSCRIPT_${tabid}`];

            let local_config: LocalizedConfig = {
                ...config,
                READ_PLAYER_BLACKLIST: is_pure_env ? false : config.READ_PLAYER_BLACKLIST,
                USERSCRIPT: userscript,

                BLACKLIST: [],
                GLOBAL_SWITCH: state.GLOBAL_SWITCH,
                SKIP_INJECT: is_pure_env,
            };

            return {
                tabid: sender.tab?.id,
                local_config: local_config,
            };
        }

        worker().then((res)=>{
            sendResponse({
                error: null,
                result: res,
            });
        }, (err)=>{
            sendResponse({
                error: ''+err,
            });
        });
        return true;
    }
    else if(msg.type==='update_badge') {
        if(!msg.tabid) {
            console.error('pakku background: no tabid for update_badge');
            return;
        }

        // may throw error because the tabid may be closing
        chrome.action.setBadgeText({
            tabId: msg.tabid,
            text: msg.text,
        }) // will fail in earlier chrome versions if text is null: https://issues.chromium.org/issues/40858508
            .then(()=>
                chrome.action.setBadgeBackgroundColor({
                    tabId: msg.tabid,
                    color: msg.bgcolor || DEFAULT_BADGE_BGCOLOR,
                })
            )
            .catch(()=>{});

        // refresh the popup
        chrome.runtime.sendMessage({type: 'reload_popup_state', tabid: msg.tabid})
            .catch(()=>{});
    }
    else if(msg.type==='toggle_switch') {
        let perform = async ()=>{
            await toggle_global_switch();
            sendResponse(null);
        }
        void perform();
        return true;
    }
    else if(msg.type==='reset_dnr_status') {
        void install_dnr_rule();
    }
    else if(msg.type==='bili_subtitle') {
        let perform = async ()=>{
            try {
                let cached = subtitle_cache.get(msg.cid);
                if(cached) {
                    sendResponse({error: null, lines: cached});
                    return;
                }
                let pv = await fetch(`https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(msg.bvid)}&cid=${msg.cid}`, {credentials: 'include'});
                let pvj = await pv.json();
                if(pvj && pvj.code === -352 || pvj && pvj.code === -412) {
                    sendResponse({error: 'risk control ' + pvj.code, lines: null});
                    return;
                }
                let subs = (pvj && pvj.data && pvj.data.subtitle && pvj.data.subtitle.subtitles) || [];
                if(!subs.length) {
                    subtitle_cache.set(msg.cid, []);
                    sendResponse({error: 'no_subtitle', lines: []}); // remember: don't retry this video
                    return;
                }
                // uploader-provided (non-AI) Chinese subtitles are the most accurate
                // transcript; fall back to the AI Chinese track, which newer videos
                // essentially always have, then any other track
                let rank = (x: any) => {
                    let lan = x.lan || '';
                    if(lan.startsWith('zh'))
                        return 0;
                    if(lan === 'ai-zh')
                        return 1;
                    if(lan.startsWith('ai'))
                        return 2;
                    return 3;
                };
                subs.sort((a: any, b: any) => rank(a) - rank(b));
                let url: string = subs[0].subtitle_url || '';
                if(url.startsWith('//'))
                    url = 'https:' + url;
                let st = await fetch(url, {credentials: 'include'});
                let stj = await st.json();
                let lines = ((stj && stj.body) || []).map((l: any) => ({from: l.from, to: l.to, content: l.content}));
                subtitle_cache.set(msg.cid, lines);
                sendResponse({error: null, lines});
            } catch(e: any) {
                sendResponse({error: e.message || String(e), lines: null});
            }
        }
        void perform();
        return true;
    }
    else if(msg.type==='ai_log_append') {
        ai_log_push(msg.rec);
        sendResponse({ok: true});
    }
    else if(msg.type==='ai_log_get') {
        sendResponse({lines: ai_log_lines});
    }
    else if(msg.type==='ai_log_clear') {
        ai_log_lines = [];
        void chrome.storage.local.remove('ai_log');
        sendResponse({ok: true});
    }
    else if(msg.type==='jev_ready') {
        let perform = async ()=>{
            let ready = false;
            try {
                let st = await chrome.storage.local.get('AI_API_KEY');
                ready = !!st.AI_API_KEY;
            } catch {}
            sendResponse({ready});
        }
        void perform();
        return true;
    }
    else if(msg.type==='jev_call') {
        let perform = async ()=>{
            try {
                let key = '';
                try {
                    let st = await chrome.storage.local.get('AI_API_KEY');
                    key = st.AI_API_KEY || '';
                } catch {}
                if(!key) {
                    let config = await get_config();
                    key = config.AI_API_KEY || '';
                }
                if(!key)
                    throw new Error('no Jev API key configured');
                // hard timeout: a stalled request must never hang a scoring window
                // (the playback gate waits on window completion, so a hang would
                // stall playback gating indefinitely)
                const ctrl = new AbortController();
                const abort_timer = setTimeout(() => ctrl.abort(), 30000);
                let res: any;
                try {
                    res = await fetch('https://api.typesafe.ai/v1/systemone', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + key,
                        },
                        body: JSON.stringify(msg.body),
                        signal: ctrl.signal,
                    });
                } catch(e: any) {
                    if(e && e.name === 'AbortError') {
                        sendResponse({error: 'Jev API timeout (30s)', retryable: true, retry_after_ms: 0});
                    } else {
                        sendResponse({error: e.message || String(e)});
                    }
                    return;
                } finally {
                    clearTimeout(abort_timer);
                }
                if(res.status===401 || res.status===403)
                    throw new Error('Jev API key invalid (' + res.status + ')');
                if(res.status===429 || res.status===529) {
                    // signal the caller to retry with exponential backoff
                    let retry_after_ms = 0;
                    try {
                        let ra = parseFloat(res.headers.get('retry-after') || '0');
                        if(isFinite(ra))
                            retry_after_ms = Math.round(ra * 1000);
                    } catch {}
                    sendResponse({error: 'Jev API busy (' + res.status + ')', retryable: true, retry_after_ms});
                    return;
                }
                if(!res.ok)
                    throw new Error('Jev API error ' + res.status);
                let data = await res.json();
                if(!data || !data.answers)
                    throw new Error('Jev API: malformed response');
                sendResponse({error: null, data: data});
            } catch(e: any) {
                sendResponse({error: e.message || String(e)});
            }
        }
        void perform();
        return true;
    }
    else if(msg.type==='xhr_proxy') {
        let perform = async ()=>{
            try {
                let res = await fetch(msg.url);
                let status = res.status;
                let text = await res.text();
                sendResponse({
                    error: null,
                    text: text,
                    status: status,
                });
            } catch(e) {
                sendResponse({
                    error: e,
                });
            }
        }
        void perform();
        return true;
    }
});

async function handle_command(name: string) {
    if(name==='toggle-global-switch') {
        let new_switch = await toggle_global_switch();

        chrome.notifications.create('//switch', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('assets/logo.png'),
            title: `[ ${new_switch ? 'ON' : 'OFF'} ]`,
            message: 'Pakku is ' + (new_switch ? 'ON' : 'OFF'),
        });

        if(_clear_timeout)
            clearTimeout(_clear_timeout);
        _clear_timeout = setTimeout(function() {
            chrome.notifications.clear('//switch');
        }, 1500) as any;
    }
    else if(name==='show-local') {
        void chrome.tabs.create({url: chrome.runtime.getURL('/page/parse_local.html')});
    }
}

let _clear_timeout: number | null = null;
chrome.commands.onCommand.addListener(function(name) {
    void handle_command(name);
});

chrome.contextMenus.onClicked.addListener(async function(info, tab) {
    void handle_command(info.menuItemId as string);
});