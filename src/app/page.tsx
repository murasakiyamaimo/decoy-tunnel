'use client';
import React, {useState} from 'react';


export default function HomePage() {
    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<number | null>(null);
    const [headers, setHeaders] = useState<Record<string, string> | null>(null);
    const [bodyText, setBodyText] = useState<string | null>(null);
    const [contentType, setContentType] = useState<string | null>(null);
    const [iframeSrc, setIframeSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);


    async function handleFetch(e?: React.FormEvent) {
        e?.preventDefault();
        setError(null);
        setStatus(null);
        setHeaders(null);
        setBodyText(null);
        setIframeSrc(null);
        setContentType(null);


        if (!url) {
            setError('URL を入力してください');
            return;
        }


        setLoading(true);
        const proxiedUrl = `/api/proxy?url=${encodeURIComponent(url)}`;

        try {
            // ステータスとヘッダーを取得するために、プロキシエンドポイントを一度 fetch する（ボディは読み込まない）
            const res = await fetch(proxiedUrl, { method: 'HEAD' }); // HEADリクエストで十分

            // ステータスとヘッダーの表示ロジックはそのまま
            setStatus(res.status);
            const hdrs: Record<string, string> = {};
            res.headers.forEach((v, k) => (hdrs[k] = v));
            setHeaders(hdrs);
            const ct = res.headers.get('content-type') || '';
            setContentType(ct);

            // -------------------------------------------------------------
            // 【最重要変更点】HTMLの場合の Blob 作成処理を削除
            // -------------------------------------------------------------
            if (ct.includes('text/html')) {
                // HTML の場合は Blob にせず、計算したプロキシURLを iframe の src に直接設定
                setIframeSrc(proxiedUrl);
                setBodyText(null); // 生のHTML表示は、Blobからでは不可能になるためクリア
            } else {
                // 非HTMLの場合は、元の処理（ダウンロードなど）
                setIframeSrc(proxiedUrl);
                // ... (必要に応じて bodyText を設定するロジックを修正)
            }
        } catch (err: any) {
            console.error(err);
            setError(String(err?.message ?? err));
        } finally {
            setLoading(false);
        }
    }


    return (
        <main style={{padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 980, margin: '0 auto'}}>
            <h1>URL プロキシ / 中継デモ</h1>
            <p>ブラウザからアクセスして、ここに対象の URL を入力するとサーバ側で取得して結果を表示します。</p>


            <form onSubmit={handleFetch} style={{display: 'flex', gap: 8, marginBottom: 12}}>
                <input
                    type="url"
                    placeholder="https://example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    style={{flex: 1, padding: 8, fontSize: 16}}
                />
                <button type="submit" disabled={loading} style={{padding: '8px 12px'}}>
                    {loading ? '取得中...' : '取得'}
                </button>
            </form>

            {error && <div style={{color: 'crimson'}}>{error}</div>}


            {status !== null && (
                <div style={{marginTop: 12}}>
                    <strong>ステータス:</strong> {status}
                </div>
            )}


            {headers && (
                <div style={{marginTop: 8}}>
                    <strong>ヘッダ:</strong>
                    <pre style={{
                        whiteSpace: 'pre-wrap',
                        background: '#f6f6f6',
                        padding: 8
                    }}>{JSON.stringify(headers, null, 2)}</pre>
                </div>
            )}


            {contentType && contentType.includes('text/html') && iframeSrc && (
                <div style={{marginTop: 12}}>
                    <strong>HTML プレビュー</strong>
                    <div style={{border: '1px solid #ddd', marginTop: 8}}>
                        <iframe src={iframeSrc} style={{width: '100%', height: 600}}
                                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox"></iframe>
                    </div>
                </div>
            )}

            {bodyText && (
                <div style={{marginTop: 12}}>
                    <strong>ボディ</strong>
                    <pre style={{whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 8}}>{bodyText}</pre>
                </div>
            )}


            {iframeSrc && contentType && !contentType.includes('text/html') && (
                <div style={{marginTop: 8}}>
                    <a href={iframeSrc} download>ダウンロード</a>
                </div>
            )}
        </main>
    );
}
