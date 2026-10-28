//! Yahoo Finance chart data proxy for the Currency page.
//! Requests run in Rust so WebView CORS restrictions do not block Yahoo's response.

use serde_json::Value;
use std::time::Duration;

const ALLOWED_SYMBOLS: &[&str] = &[
    "BBCA.JK", "BBRI.JK", "BMRI.JK", "BBNI.JK", "TLKM.JK", "ASII.JK",
    "ANTM.JK", "GOTO.JK", "ICBP.JK", "MDKA.JK", "BRPT.JK", "INDF.JK",
];

#[tauri::command]
pub async fn fetch_yahoo_chart(
    symbol: String,
    period1: i64,
    period2: i64,
) -> Result<Value, String> {
    if !ALLOWED_SYMBOLS.contains(&symbol.as_str()) {
        return Err(format!("Simbol saham tidak diizinkan: {symbol}"));
    }
    if period1 <= 0 || period2 <= period1 {
        return Err("Rentang tanggal saham tidak valid".to_string());
    }

    // reqwest blocking harus dijalankan di worker, bukan pada thread UI Tauri.
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 NotchApp/1.0")
            .build()
            .map_err(|e| format!("Gagal membuat HTTP client: {e}"))?;

        let mut last_error = String::from("Yahoo Finance tidak dapat diakses");
        for host in ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] {
            let url = format!(
                "https://{host}/v8/finance/chart/{}?period1={period1}&period2={period2}&interval=1d&events=history",
                symbol
            );
            match client
                .get(&url)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
            {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        last_error = format!("Yahoo Finance mengembalikan HTTP {status}");
                        continue;
                    }
                    match response.json::<Value>() {
                        Ok(json) => {
                            if json.get("chart").is_some() {
                                return Ok(json);
                            }
                            last_error = "Format respons Yahoo Finance tidak valid".to_string();
                        }
                        Err(e) => last_error = format!("Respons Yahoo Finance bukan JSON valid: {e}"),
                    }
                }
                Err(e) => last_error = format!("Request ke {host} gagal: {e}"),
            }
        }
        Err(last_error)
    })
    .await
    .map_err(|e| format!("Worker Yahoo Finance gagal: {e}"))?
}
