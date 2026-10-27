//! Fetching the URL schemas `json:SCHEMA` inputs reference (#51), for the form to check them.
//! The webview can't: most schema hosts don't allow its origin (CORS). The inlining and the cache
//! are clyops-schema's, in the frontend; this is one download, as clyops-tools does it in Node.

use reqwest::header::{ACCEPT, LOCATION};
use std::sync::Once;
use std::time::Duration;

const MAX_REDIRECTS: usize = 5;
static CRYPTO: Once = Once::new();

/// Whether `host` is one `hosts` allows (`example.com`, or `*.example.com` for its subdomains);
/// any host when `hosts` is empty.
pub fn host_allowed(host: &str, hosts: &[String]) -> bool {
    if hosts.is_empty() {
        return true;
    }
    let host = host.to_ascii_lowercase();
    hosts.iter().any(|entry| {
        let allowed = entry.trim().to_ascii_lowercase();
        match allowed.strip_prefix("*.") {
            Some(domain) => host.ends_with(&format!(".{domain}")),
            None => host == allowed,
        }
    })
}

fn describe(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "timed out".to_string()
    } else {
        err.to_string()
    }
}

/// One schema document: its JSON, or why not. Redirects are followed by hand, so each hop is
/// checked against `hosts`; the whole fetch takes at most `timeout_ms` and `max_bytes`.
pub async fn fetch(
    url: &str,
    hosts: &[String],
    timeout_ms: u64,
    max_bytes: usize,
) -> Result<serde_json::Value, String> {
    // reqwest is built without a crypto provider (see Cargo.toml): ring, installed once.
    CRYPTO.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| e.to_string())?;
    let mut target = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let mut hops = 0;
    loop {
        let host = target.host_str().unwrap_or("").to_string();
        if !host_allowed(&host, hosts) {
            return Err(format!("host {host} is not in the allowed schema hosts"));
        }
        let mut res = client
            .get(target.clone())
            .header(ACCEPT, "application/schema+json, application/json")
            .send()
            .await
            .map_err(describe)?;
        if res.status().is_redirection() {
            if let Some(location) = res.headers().get(LOCATION).and_then(|v| v.to_str().ok()) {
                if hops >= MAX_REDIRECTS {
                    return Err(format!("more than {MAX_REDIRECTS} redirects"));
                }
                target = target.join(location).map_err(|e| e.to_string())?;
                hops += 1;
                continue;
            }
        }
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(describe)? {
            body.extend_from_slice(&chunk);
            if body.len() > max_bytes {
                return Err(format!("larger than {max_bytes} bytes"));
            }
        }
        let doc: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| "not JSON".to_string())?;
        if !(doc.is_object() || doc.is_boolean()) {
            return Err("not a JSON Schema (an object or a boolean)".to_string());
        }
        return Ok(doc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // A one-shot HTTP server per request: each path answers with a fixed response.
    async fn serve(routes: Vec<(&'static str, String)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let response = routes
                        .iter()
                        .find(|(p, _)| *p == path)
                        .map(|(_, r)| r.clone())
                        .unwrap_or_else(|| {
                            "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n".to_string()
                        });
                    if response == "SLOW" {
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                    }
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        base
    }

    fn ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body)
    }

    fn redirect(to: &str) -> String {
        format!("HTTP/1.1 302 Found\r\nlocation: {to}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    }

    #[test]
    fn hosts() {
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(host_allowed("a.example.org", &list(&["*.example.org"])));
        assert!(!host_allowed("example.org", &list(&["*.example.org"])));
        assert!(!host_allowed("badexample.org", &list(&["*.example.org"])));
        assert!(host_allowed("EXAMPLE.org", &list(&["example.ORG"])));
        assert!(host_allowed("anything", &[]));
    }

    #[tokio::test]
    async fn fetches_and_reports_why_not() {
        let big = format!("{{\"description\": \"{}\"}}", "x".repeat(2000));
        let base = serve(vec![
            ("/ok.json", ok(r#"{"type":"string"}"#)),
            ("/html", ok("<html>")),
            ("/array.json", ok("[1]")),
            ("/big.json", ok(&big)),
            ("/slow.json", "SLOW".to_string()),
            ("/loop", redirect("/loop")),
            ("/away", redirect("http://localhost:1/ok.json")),
            ("/hop", redirect("/ok.json")),
        ])
        .await;
        let get = |path: &str, hosts: Vec<String>, timeout: u64, max: usize| {
            let url = format!("{base}{path}");
            async move { fetch(&url, &hosts, timeout, max).await }
        };
        assert_eq!(
            get("/ok.json", vec![], 5000, 1 << 20).await,
            Ok(serde_json::json!({ "type": "string" }))
        );
        assert_eq!(
            get("/hop", vec![], 5000, 1 << 20).await,
            Ok(serde_json::json!({ "type": "string" }))
        );
        assert_eq!(
            get("/missing", vec![], 5000, 1 << 20).await,
            Err("HTTP 404".to_string())
        );
        assert_eq!(
            get("/html", vec![], 5000, 1 << 20).await,
            Err("not JSON".to_string())
        );
        assert_eq!(
            get("/array.json", vec![], 5000, 1 << 20).await,
            Err("not a JSON Schema (an object or a boolean)".to_string())
        );
        assert_eq!(
            get("/big.json", vec![], 5000, 1000).await,
            Err("larger than 1000 bytes".to_string())
        );
        assert_eq!(
            get("/slow.json", vec![], 200, 1 << 20).await,
            Err("timed out".to_string())
        );
        assert_eq!(
            get("/loop", vec![], 5000, 1 << 20).await,
            Err("more than 5 redirects".to_string())
        );
        let local = vec!["127.0.0.1".to_string()];
        assert_eq!(
            get("/away", local.clone(), 5000, 1 << 20).await,
            Err("host localhost is not in the allowed schema hosts".to_string())
        );
        assert_eq!(
            get("/ok.json", vec!["localhost".to_string()], 5000, 1 << 20).await,
            Err("host 127.0.0.1 is not in the allowed schema hosts".to_string())
        );
        assert!(get("/ok.json", local, 5000, 1 << 20).await.is_ok());
    }
}
