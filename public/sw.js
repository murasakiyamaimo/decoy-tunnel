// プロキシエンドポイントのパスを設定
const PROXY_PATH = '/api/proxy';
// YouTubeドメインをターゲットに設定
const TARGET_HOSTNAMES = [
    'www.youtube.com',
    'm.youtube.com',
    's.youtube.com',
    'i.ytimg.com',
    'yt3.ggpht.com',
    'googlevideo.com', // 👈 動画ストリーミングに不可欠
    'www.google.com', // 👈 認証やAPI関連
    'accounts.google.com', // 👈 認証関連
];

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // 1. Service Worker が処理すべきリクエストか判断

    // 1a. このオリジン (セルフ) へのリクエストか？
    if (url.origin === self.location.origin) {
        // (A) /api/proxy へのリクエストは絶対に傍受しない (無限ループ回避)
        if (url.pathname === PROXY_PATH || url.pathname.startsWith(PROXY_PATH + '/')) {
            return;
        }
        // (B) その他のローカルリソース (/page.tsx, /sw.js など) はそのまま通す
        // (キャッシュ戦略が必要ならここに追加)
        return;
    }

    // 1b. 外部オリジンへのリクエストか？
    // (例: iframe 内のJSが 'https://www.youtube.com/api/...' を叩いた)

    // 2. 外部オリジンのうち、プロキシ対象かチェック
    const isTarget = TARGET_HOSTNAMES.some(host =>
        url.hostname === host || url.hostname.endsWith('.' + host)
    );

    if (!isTarget) {
        // プロキシ対象外の外部ドメイン (例: google-analytics.com) は
        // そのままリクエストさせる (CORSで失敗する可能性大だが、SWの責任外)
        return;
    }

    // 3. 捕捉したリクエストをプロキシURLに書き換える
    // (例: https://www.youtube.com/api/... -> /api/proxy?url=https%3A%2F%2Fwww.youtube.com%2Fapi%2F...)
    const proxiedUrl = `${self.location.origin}${PROXY_PATH}?url=${encodeURIComponent(request.url)}`;

    // 4. 新しいリクエストを作成し、プロキシ経由で実行
    event.respondWith(
        (async () => {
            try {
                // 元のリクエストのオプションをコピー
                const init: RequestInit = {
                    method: request.method,
                    headers: request.headers,
                    // 'GET', 'HEAD' 以外の場合はボディをクローンして渡す
                    body: (request.method !== 'GET' && request.method !== 'HEAD') ? await request.clone().arrayBuffer() : undefined,
                    mode: 'same-origin', // /api/proxy は同一オリジン
                    credentials: request.credentials,
                    cache: request.cache,
                    redirect: request.redirect,
                    referrer: request.referrer,
                };

                // 元のリクエストの AbortSignal を引き継ぐ
                if (request.signal) {
                    init.signal = request.signal;
                }

                // プロキシエンドポイント (/api/proxy) にフェッチ
                const response = await fetch(proxiedUrl, init);

                // プロキシからのレスポンスをそのまま返す
                return response;

            } catch (error: any) {
                console.error(`SW: Proxy fetch failed for: ${request.url}`, error);
                // エラーが発生した場合、ネットワークエラーを返す
                return new Response(`Service Worker: Failed to proxy request to ${proxiedUrl}. Error: ${error?.message || error}`, {
                    status: 502, // Bad Gateway
                    statusText: 'Bad Gateway (SW Proxy Error)',
                });
            }
        })()
    );
});

self.addEventListener('activate', (event) => {
    // Service Worker がアクティブになったら、すぐにクライアントを制御下に置く
    event.waitUntil(self.clients.claim());
});

self.addEventListener('install', (event) => {
    // インストール後、すぐにアクティブにする (古いSWを待たない)
    event.waitUntil(self.skipWaiting());
});