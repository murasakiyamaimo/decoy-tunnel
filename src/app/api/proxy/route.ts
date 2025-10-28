// app/api/proxy/route.ts
import { NextRequest, NextResponse } from 'next/server';

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

// 簡易 HTML リライト（href/src/srcset/action/formのaction、<base>処理など）
// この関数は完全な HTMLRewriter の代替ではありませんが多くのケースで動作します。
// 注意: 大量置換は誤置換を招くため、必要に応じて DOM パーサに置き換えてください。
function rewriteHtml(baseUrl: string, html: string) {
    // resolve relative URLs to absolute using URL constructor
    const base = new URL(baseUrl);

    // attributes to rewrite: href, src, action, data-src, poster, srcset (handled separately)
    // rewrite absolute and relative URLs that start with http/https or are relative paths
    // simple regex-based approach:
    //  - href="...": replace with proxy URL
    //  - src="..."
    //  - action="..."
    //  - srcset="..." -> each url in srcset should be rewritten

    // helper to resolve and wrap as proxy
    function resolveAndProxy(urlStr: string) {
        try {
            const trimmed = urlStr.trim();
            // ignore data:, mailto:, javascript:
            if (/^data:|^mailto:|^javascript:/i.test(trimmed)) return urlStr;
            // absolute?
            const resolved = new URL(trimmed, base).href;
            return makeProxyUrl(resolved);
        } catch (e) {
            return urlStr;
        }
    }

    // srcset handling: multiple comma-separated entries url [space descriptor]
    html = html.replace(/srcset\s*=\s*"(.*?)"/gms, (_, val) => {
        try {
            const parts = val.split(',');
            const newParts = parts.map((p: string) => {
                const m = p.trim().match(/^(.*?)((\s+\d+\w?)?)$/);
                if (!m) return p;
                const urlPart = m[1];
                const desc = m[2] ?? '';
                const prox = resolveAndProxy(urlPart);
                return `${prox}${desc}`;
            });
            return `srcset="${newParts.join(', ')}"`;
        } catch {
            return `srcset="${val}"`;
        }
    });

    // generic attribute rewrites
    const attrList = ['href', 'src', 'action', 'poster', 'data-src', 'data-href'];
    for (const attr of attrList) {
        const re = new RegExp(`${attr}\\s*=\\s*"(.*?)"`, 'gms');
        html = html.replace(re, (_, val) => {
            const prox = resolveAndProxy(val);
            return `${attr}="${prox}"`;
        });
    }

    // <base href="..."> がある場合, rewrite it to point to proxied base so relative resolves
    html = html.replace(/<base\s+[^>]*href\s*=\s*"(.*?)"[^>]*>/gms, (_, val) => {
        const prox = resolveAndProxy(val);
        return `<base href="${prox}">`;
    });

    // rewrite locations in simple inline JS patterns: location.href = '...'; location = '...'
    // NOTE: this is heuristic and limited.
    html = html.replace(/(location(?:\.href|\.assign)?\s*=\s*['"])(.*?)['"]/gms, (_, p1, p2) => {
        try {
            const prox = resolveAndProxy(p2);
            return `${p1}${prox}"`;
        } catch {
            return `${p1}${p2}"`;
        }
    });

    return html;
}

// copy a subset of incoming headers to upstream. Don't forward host or connection.
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
            const ab = await req.arrayBuffer();
            fetchOpts.body = ab;
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
        if (resHeaders.has('content-security-policy')) resHeaders.delete('content-security-policy');

// Content-Encoding を削除（Brotli/gzip等を外す）
        if (resHeaders.has('content-encoding')) resHeaders.delete('content-encoding');

// Frame埋め込み制限を削除
        if (resHeaders.has('x-frame-options')) resHeaders.delete('x-frame-options');

// セキュリティヘッダ調整終わり
// -----------------------------------------------

// あとは元のステータス・ヘッダ・本文をそのまま返す
        return new Response(upstream.body, {
            status: upstream.status,
            headers: resHeaders,
        });
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
