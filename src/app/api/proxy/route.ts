// app/api/proxy/route.ts
import {NextRequest, NextResponse} from 'next/server';
import * as cheerio from 'cheerio';

export const runtime = 'nodejs';

// 設定（運用では env で管理してください）
const TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 15000);
const MAX_BODY_BYTES = Number(process.env.PROXY_MAX_BYTES ?? 10_000_000); // 10MB safety cap for buffered rewrites
const DEV_INSECURE_TLS = process.env.PROXY_DEV_INSECURE_TLS === '1'; // 開発用: 証明書エラーを無視

if (DEV_INSECURE_TLS) {
    // 開発用。絶対に本番にしないでください。
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function makeProxyUrl(targetHref: string) {
    return `/api/proxy?url=${encodeURIComponent(targetHref)}`;
}

function resolveAndProxy(val: string, base: URL) {
    // val が空、data:、mailto:、# で始まる場合はプロキシしない
    if (!val || val.startsWith('data:') || val.startsWith('mailto:') || val.startsWith('#')) {
        return val;
    }
    // 相対URLを絶対URLに解決
    const url = new URL(val, base.href);
    // プロキシURL形式に変換
    return makeProxyUrl(url.href);
}


function rewriteHtml(baseUrl: string, html: string): string {
    const base = new URL(baseUrl);
    const $ = cheerio.load(html); // 👈 HTMLをパースしてDOMを構築

    // -----------------------------------------------------------------
    // 1. 【pushState, SyntaxError 対策】baseタグの強制挿入と既存タグ削除
    // -----------------------------------------------------------------
    // 既存の <base> タグを全て削除
    $('base').remove();

    // <head> タグを見つけ、プロキシURLを指す新しい <base> タグを先頭に挿入
    const proxiedBaseUrl = makeProxyUrl(baseUrl);
    const baseTag = `<base href="${proxiedBaseUrl}">`;
    $('head').prepend(baseTag);

    // -----------------------------------------------------------------
    // 2. 【CORS, リンク切れ対策】すべてのURL属性をプロキシURLに書き換え
    // -----------------------------------------------------------------
    // 書き換え対象の属性リスト
    const attrList = ['href', 'src', 'action', 'poster', 'data-src', 'data-href', 'srcset'];

    // すべての要素に対して反復処理
    $('*').each((i, element) => {
        const $el = $(element);

        // 各属性をチェック
        for (const attr of attrList) {
            const val = $el.attr(attr);
            if (val) {
                try {
                    const proxied = resolveAndProxy(val, base);
                    // 書き換え後の値が元の値と異なる場合のみ設定
                    if (proxied !== val) {
                        $el.attr(attr, proxied);
                    }
                } catch (e) {
                    // URL解決に失敗した場合は無視
                    console.warn(`Failed to resolve URL for ${attr}: ${val}`, e);
                }
            }
        }
    });

    // -----------------------------------------------------------------
    // 3. 【SecurityError 対策】危険なJavaScriptコードの無効化
    // -----------------------------------------------------------------
    // History API や document.domain の操作は Blob/iframe 環境でエラーになるため、
    // これらの関数呼び出しを含むインラインスクリプトを安全のためブロックまたは変更します。
    // *cheerioではJSコード内の文字列リライトは困難なため、ここでは document.domain の除去のみ*

    /*
    $('script').each((i, element) => {
        const $script = $(element);
        let content = $script.html();
        if (content) {
            // document.domain の設定をコメントアウト (SecurityError回避)
            content = content.replace(/document\.domain\s*=\s*['"][^'"]+['"];?/gi, '// blocked document.domain setting;');
            $script.html(content);
        }
    });
     */

    // 最終的なHTMLを文字列として出力
    return $.html();
}

function buildForwardHeaders(req: NextRequest) {
    const out = new Headers();
    const forwardKeys = ['accept', 'accept-language', 'content-type', 'cookie', 'user-agent', 'referer', 'range'];
    for (const k of forwardKeys) {
        const v = req.headers.get(k);
        if (v) out.set(k, v);
    }
    // force no compression from upstream so we get plain text to rewrite easily
    out.set('accept-encoding', 'identity');
    if (!out.get('user-agent')) {
        out.set('user-agent', 'Mozilla/5.0 (Proxy)');
    }
    return out;
}

export async function GET(req: NextRequest) {
    return handleProxy(req);
}
export async function POST(req: NextRequest) {
    return handleProxy(req);
}
export async function PUT(req: NextRequest) {
    return handleProxy(req);
}
export async function DELETE(req: NextRequest) {
    return handleProxy(req);
}
export async function PATCH(req: NextRequest) {
    return handleProxy(req);
}
export async function OPTIONS(req: NextRequest) {
    return handleProxy(req);
}

async function handleProxy(req: NextRequest) {
    const urlParam = req.nextUrl.searchParams.get('url') ?? '';
    if (!urlParam) return NextResponse.json({ error: 'missing url param' }, { status: 400 });

    let target: URL;
    try {
        target = new URL(urlParam);
    } catch (e) {
        return NextResponse.json({ error: 'invalid url' }, { status: 400 });
    }

    // Basic: only allow http/https
    if (!['http:', 'https:'].includes(target.protocol)) {
        return NextResponse.json({ error: 'unsupported protocol' }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const forwardHeaders = buildForwardHeaders(req);

        // Build fetch options
        const fetchOpts: RequestInit = {
            method: req.method,
            headers: forwardHeaders,
            signal: controller.signal,
        };

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
            // forward body (arrayBuffer supported)
            fetchOpts.body = await req.arrayBuffer();
        }

        const upstream = await fetch(target.href, fetchOpts);

// Hop-by-hop ヘッダを削除（RFC 7230 準拠）
        const hopByHop = new Set([
            'connection',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
            'te',
            'trailers',
            'transfer-encoding',
            'upgrade',
        ]);

// --- ヘッダコピー ---
        const resHeaders = new Headers();
        upstream.headers.forEach((v, k) => {
            if (!hopByHop.has(k.toLowerCase())) {
                resHeaders.set(k, v);
            }
        });

// --- 👇 ここから追加：セキュリティヘッダを緩和・削除 ---
        const forbidden = [
            'content-security-policy',
            'content-security-policy-report-only',
            'x-frame-options',
            'cross-origin-opener-policy',
            'cross-origin-embedder-policy',
            'cross-origin-resource-policy',
            'report-to',
            'reporting-endpoints',
        ];

// 不要 or 邪魔なヘッダを削除
        for (const h of forbidden) {
            if (resHeaders.has(h)) resHeaders.delete(h);
        }

// もし CSP を削除するとJSが動くようになるが危険。
// 代わりに「非常に緩いCSP」を設定することも可能（任意）
        const newCSP = `
    default-src 'self' data: http: https: ws: wss: * 'unsafe-inline' 'unsafe-eval'; 
    connect-src 'self' data: http: https: ws: wss: *;
    script-src 'self' data: http: https: 'unsafe-inline' 'unsafe-eval';
    style-src 'self' data: http: https: 'unsafe-inline';
    img-src 'self' data: http: https: *;
    media-src 'self' data: http: https: *;
    frame-src 'self' data: http: https: wss: *;
    content-src 'self' data: http: https: wss: wss: *;
`;
// 複数スペースと改行を削除して1行にする
        const cleanCSP = newCSP.replace(/\s+/g, ' ').trim();

        resHeaders.set('content-security-policy', cleanCSP);

        //if (resHeaders.has('content-security-policy')) resHeaders.delete('content-security-policy');

// Content-Encoding を削除（Brotli/gzip等を外す）
        if (resHeaders.has('content-encoding')) resHeaders.delete('content-encoding');

// Frame埋め込み制限を削除
        //if (resHeaders.has('x-frame-options')) resHeaders.delete('x-frame-options');

// セキュリティヘッダ調整終わり
// -----------------------------------------------

        // Relay Set-Cookie headers (keep them)
        const setCookie = upstream.headers.get('set-cookie');
        if (setCookie) {
            // NextResponse can't set multiple Set-Cookie via headers.set; use the Response constructor below
            resHeaders.set('set-cookie', setCookie);
        }

        // If content-type is html -> buffer small-ish responses, rewrite and return
        const contentType = upstream.headers.get('content-type') ?? '';
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            // buffer but with cap
            const reader = upstream.body?.getReader();
            if (!reader) {
                clearTimeout(timeout);
                return new NextResponse(null, { status: upstream.status, headers: resHeaders });
            }
            const chunks: Uint8Array[] = [];
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    received += value.byteLength;
                    if (received > MAX_BODY_BYTES) {
                        controller.abort();
                        return NextResponse.json({ error: 'upstream html too large' }, { status: 502 });
                    }
                    chunks.push(value);
                }
            }
            clearTimeout(timeout);
            const full = Buffer.concat(chunks.map(c => Buffer.from(c)));
            const text = full.toString('utf8');
            const rewritten = rewriteHtml(target.href, text);
            // ensure content-length is correct
            resHeaders.set('content-length', String(Buffer.byteLength(rewritten, 'utf8')));
            // return rewritten HTML
            return new NextResponse(rewritten, {
                status: upstream.status,
                headers: resHeaders,
            });
        }

        // For non-HTML, stream directly back to client (preserve type and length)
        clearTimeout(timeout);

        // Create a streaming Response using upstream.body readable stream
        const bodyStream = upstream.body;

        // Important: NextResponse accepts a ReadableStream or Uint8Array in Node runtime
        return new NextResponse(bodyStream, {
            status: upstream.status,
            headers: resHeaders,
        });

    } catch (err: unknown) {
        clearTimeout(timeout);
        if (err instanceof Error && err.name === 'AbortError') {
            return NextResponse.json({ error: 'timeout' }, { status: 504 });
        }
        console.error('proxy error', err);
        return NextResponse.json({ error: 'upstream fetch failed' }, { status: 502 });
    }
}
