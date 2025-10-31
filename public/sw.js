// プロキシエンドポイントのパスを設定
const PROXY_PATH = '/api/proxy';
// YouTubeドメインをターゲットに設定
const TARGET_HOSTNAMES = ['www.youtube.com', 'm.youtube.com', 's.youtube.com', 'i.ytimg.com'];

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. Service Worker自身へのリクエストや、オリジン外のリクエストを無視
    if (url.origin !== self.location.origin) {
        return;
    }

    // 2. プロキシ対象のホスト名チェック
    // パスから元のURLをデコードしてホスト名を取得
    const isProxyRequest = url.pathname === PROXY_PATH;

    // プロキシリクエストではない、かつ、ターゲットドメインへのリクエストではない場合は無視
    if (!isProxyRequest) {
        // iframeでロードされたコンテンツから、直接 YouTube へのリクエストを捕捉する
        // ただし、このService Workerはメインオリジンでのみ動くため、
        // 実際にはiframe内のリソースがプロキシを経由してロードされた後の内部リンクを捕捉します。

        // ターゲットドメインへのリクエストかどうかを正確に判断するのは難しいため、
        // ここでは単純に *メインオリジン外* へのリクエストをプロキシに送る戦略を取ります。

        // **最もシンプルなアプローチ:** /api/proxy 以外のリクエストはそのまま通す
        return;
    }

    // 3. 捕捉したプロキシリクエストを処理
    // Service Workerは、プロキシとして動作するよう強制的にリクエストを書き換えます。

    // 【重要】
    // このsw.jsは、iframe内のYouTubeコンテンツから送られた
    // 「/api/proxy?url=https%3A%2F%2Fwww.youtube.com%2F...」
    // のようなリクエストを処理します。これは既にプロキシURLなので、そのまま通します。

    // **真の課題は、ページ内のJSから発せられる *元の* https://www.youtube.com/api/... リクエストを捕捉し書き換えることです。**

    // 💡 解決策: Iframeのsandbox属性から 'allow-same-origin' を外す
    // `page.tsx` で `sandbox` 属性から `allow-same-origin` を外すと、
    // iframe内のJavaScriptが直接親オリジン (/api/proxy) にリクエストできなくなり、
    // すべての外部リソースがプロキシを経由することが保証されます。

    // しかし、iframeが完全に隔離されると、検索フォームの送信自体ができなくなる可能性もあります。

    // Service Workerによる透過的リライトが機能するのは、
    // Service Workerが登録されたオリジンから発信されるリクエスト（親ページから or 同一オリジンのiframeから）のみです。

    // この Service Worker は、メインページ (`page.tsx`) が発するリクエストをコントロールします。
    // iframe内のJSリクエストを捕捉するには、iframeのドメインと Service Workerのスコープを一致させる必要がありますが、
    // 現在の設計ではそれは不可能です。

    // したがって、**Service Workerは、この問題の直接的な解決策にはなりません。**
    // 理由：Service Workerはメインドメインにしか登録できず、**iframe内部から外部ドメイン（YouTube）へのリクエスト**を捕捉できないためです。

    // 代替策（#4へ）
});