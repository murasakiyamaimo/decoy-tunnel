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
        try {
// URL はクエリパラメータで送る（エンコード）
            const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
            setStatus(res.status);


            const hdrs: Record<string, string> = {};
            res.headers.forEach((v, k) => (hdrs[k] = v));
            setHeaders(hdrs);


            const ct = res.headers.get('content-type') || '';
            setContentType(ct);


// HTML の場合は blob を作って sandboxed iframe に流し込む（スクリプトは実行しない）
            if (ct.includes('text/html')) {
                const text = await res.text();
                const blob = new Blob([text], {type: 'text/html'});
                const blobUrl = URL.createObjectURL(blob);
                setIframeSrc(blobUrl);
                setBodyText(null);
            } else if (ct.startsWith('text/') || ct.includes('json')) {
                const text = await res.text();
                setBodyText(text);
            } else {
// バイナリ等はダウンロードリンクとして扱う
                const arrayBuf = await res.arrayBuffer();
                const blob = new Blob([arrayBuf], {type: ct || 'application/octet-stream'});
                const blobUrl = URL.createObjectURL(blob);
                setBodyText(`ダウンロード: ${blobUrl}`);
                setIframeSrc(blobUrl);
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
