#!/usr/bin/env python3
"""Fetch the AI-generated subtitle track of a bilibili video (requires login cookies).

Usage:
  python3 fetch_subtitle.py <bvid> [--cid CID] [--proxy socks5h://127.0.0.1:11080] \
      [--cookie /tmp/bili_cookies.json] [--out subtitle.json]

Resolves cid automatically when omitted. Saves the subtitle JSON
({body: [{from, to, content}, ...]}, seconds) or prints an error.
"""
import argparse, json, sys, time

import requests

UA = 'Mozilla/5.0'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('bvid')
    ap.add_argument('--cid', type=int, default=0)
    ap.add_argument('--proxy', default=None)
    ap.add_argument('--cookie', default='/tmp/bili_cookies.json')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    s = requests.Session()
    s.headers['User-Agent'] = UA
    s.headers['Referer'] = 'https://www.bilibili.com/'
    if args.proxy:
        s.proxies = {'http': args.proxy, 'https': args.proxy}
    try:
        login = json.load(open(args.cookie))
        for k, v in login['cookies'].items():
            s.cookies.set(k, v, domain='.bilibili.com')
    except FileNotFoundError:
        sys.exit(f'cookie file not found: {args.cookie} (run bili_login.py first)')

    cid = args.cid
    if not cid:
        v = s.get('https://api.bilibili.com/x/web-interface/view',
                  params={'bvid': args.bvid}, timeout=15).json()
        if v.get('code') != 0:
            sys.exit(f'view failed: code={v.get("code")} {v.get("message")}')
        cid = v['data']['cid']
        print(f"resolved cid={cid} title={v['data']['title']}")

    p = s.get('https://api.bilibili.com/x/player/wbi/v2',
              params={'bvid': args.bvid, 'cid': cid}, timeout=15).json()
    if p.get('code') != 0:
        sys.exit(f'player failed: code={p.get("code")} {p.get("message")}')
    subs = (p.get('data') or {}).get('subtitle', {}).get('subtitles', [])
    if not subs:
        sys.exit('no subtitles (login required for AI subtitles; or this video has none)')
    # prefer ai-zh, then any zh, then anything
    def rank(x):
        lan = x.get('lan', '')
        return (0 if lan == 'ai-zh' else 1 if lan.startswith('zh') else 2, lan)
    subs.sort(key=rank)
    chosen = subs[0]
    print(f"tracks: {[(x.get('lan'), x.get('lan_doc')) for x in subs]}")
    print(f"chose: {chosen.get('lan')} ({chosen.get('lan_doc')})")

    url = chosen['subtitle_url']
    if url.startswith('//'):
        url = 'https:' + url
    r = s.get(url, timeout=20)
    r.raise_for_status()
    doc = r.json()
    lines = doc.get('body', [])
    print(f'{len(lines)} subtitle lines, span {lines[0]["from"] if lines else "-"}s..'
          f'{lines[-1]["to"] if lines else "-"}s')
    out = args.out or f'subtitle_{cid}.json'
    json.dump({'cid': cid, 'lan': chosen.get('lan'), 'body': lines},
              open(out, 'w'), ensure_ascii=False, indent=1)
    print(f'saved to {out}')
    for l in lines[:8]:
        print(f'  {l["from"]:>8.1f}  {l["content"][:40]}')


if __name__ == '__main__':
    main()
