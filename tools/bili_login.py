#!/usr/bin/env python3
"""Bilibili QR-code login helper for super-danmuku development.

Obtains login cookies (SESSDATA etc.) via the passport QR login flow, so we can
fetch login-gated APIs (AI subtitles) for testing without touching a browser.

Usage:
  python3 bili_login.py [--proxy socks5h://127.0.0.1:11080] \
      [--qr-out /tmp/bili_qr.png] [--cookie-out /tmp/bili_cookies.json]

Prints a QR code (also saved as PNG). Scan it with the Bilibili mobile app;
the script polls until confirmed, then saves cookies (mode 600) and prints
non-sensitive account info. NEVER print or commit the cookie file.
"""
import argparse, json, sys, time, os

import requests

UA = 'Mozilla/5.0'  # keep it consistent with the TLS fingerprint of python-requests


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--proxy', default=None, help='e.g. socks5h://127.0.0.1:11080')
    ap.add_argument('--qr-out', default='/tmp/bili_qr.png')
    ap.add_argument('--cookie-out', default='/tmp/bili_cookies.json')
    ap.add_argument('--timeout', type=int, default=185, help='seconds to wait for scan')
    args = ap.parse_args()

    proxies = {'http': args.proxy, 'https': args.proxy} if args.proxy else None
    s = requests.Session()
    s.headers['User-Agent'] = UA
    s.headers['Referer'] = 'https://www.bilibili.com/'
    if proxies:
        s.proxies = proxies

    # buvid makes the session look normal (and is needed by some endpoints)
    try:
        spi = s.get('https://api.bilibili.com/x/frontend/finger/spi', timeout=15).json()
        s.cookies.set('buvid3', spi['data']['b_3'], domain='.bilibili.com')
        s.cookies.set('buvid4', spi['data']['b_4'], domain='.bilibili.com')
    except Exception as e:
        print(f'warn: finger/spi failed ({e}), continuing without buvid', file=sys.stderr)

    r = s.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', timeout=15).json()
    if r.get('code') != 0:
        sys.exit(f'qrcode generate failed: {r}')
    qr_url, qrcode_key = r['data']['url'], r['data']['qrcode_key']
    print('QR url:', qr_url)

    try:
        import qrcode
        qrcode.make(qr_url).save(args.qr_out)
        print(f'QR image saved to {args.qr_out}')
    except ImportError:
        print('(pip install qrcode pillow to also save a PNG)', file=sys.stderr)

    deadline = time.time() + args.timeout
    last = None
    while time.time() < deadline:
        pr = s.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
                   params={'qrcode_key': qrcode_key}, timeout=15).json()
        data = pr.get('data') or {}
        # QR status lives in data.code (86038 expired / 86090 scanned / 86101 not scanned / 0 ok);
        # the outer code only reflects transport success
        code = data.get('code', pr.get('code'))
        msg = data.get('message') or pr.get('message') or ''
        if code != last:
            print(f'[poll] {code} {msg}', flush=True)
            last = code
        if code == 0:
            cookies = {c.name: c.value for c in s.cookies}
            if 'SESSDATA' not in cookies:
                print('outer code 0 but no SESSDATA, still waiting', flush=True)
                time.sleep(2)
                continue
            out = {
                'cookies': cookies,
                'refresh_token': data.get('refresh_token', ''),
                'ts': int(time.time()),
            }
            with open(args.cookie_out, 'w') as f:
                json.dump(out, f, ensure_ascii=False, indent=1)
            os.chmod(args.cookie_out, 0o600)
            print(f'cookies saved to {args.cookie_out} (mid={cookies.get("DedeUserID")})')
            # non-sensitive check
            nav = s.get('https://api.bilibili.com/x/web-interface/nav', timeout=15).json()
            if nav.get('code') == 0:
                print(f'login OK as: {nav["data"]["uname"]} (vip={nav["data"]["vipStatus"]})')
            else:
                print(f'nav check failed: {nav.get("code")}')
            return
        if code == 86038:
            sys.exit('QR code expired, rerun the script')
        time.sleep(2)
    sys.exit('timeout waiting for scan')


if __name__ == '__main__':
    main()
