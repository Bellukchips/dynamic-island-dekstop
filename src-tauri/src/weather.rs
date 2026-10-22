use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
struct Resp {
    current: Current,
    minutely_15: Option<Minutely>,
}

#[derive(Deserialize)]
struct Current {
    temperature_2m: f64,
    apparent_temperature: f64,
    relative_humidity_2m: f64,
    weather_code: u32,
    is_day: u8,
}

#[derive(Deserialize)]
struct Minutely {
    precipitation: Vec<Option<f64>>,
}

#[derive(Serialize, Clone)]
struct WeatherEvent {
    temp: f64,
    feels: f64,
    humidity: f64,
    code: u32,
    is_day: bool,
    rain_in: Option<u32>, // menit sampai hujan, kalau saat ini belum hujan
}

fn fetch() -> Result<WeatherEvent, String> {
    let wc = &crate::config::get().weather;
    let (lat, lon) = (wc.lat, wc.lon);
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}\
         &current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day\
         &minutely_15=precipitation&forecast_minutely_15=8&timezone=auto"
    );
    let r: Resp = reqwest::blocking::get(url)
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    let c = r.current;
    let raining_now = (51..=67).contains(&c.weather_code)
        || (80..=82).contains(&c.weather_code)
        || c.weather_code >= 95;

    // cari slot 15 menit pertama dengan curah hujan berarti
    let rain_in = if raining_now {
        None
    } else {
        r.minutely_15.and_then(|m| {
            m.precipitation
                .iter()
                .position(|p| p.unwrap_or(0.0) >= 0.2)
                .map(|i| (i as u32 + 1) * 15)
        })
    };

    Ok(WeatherEvent {
        temp: c.temperature_2m,
        feels: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        code: c.weather_code,
        is_day: c.is_day == 1,
        rain_in,
    })
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut alerted = false;
        loop {
            match fetch() {
                Ok(w) => {
                    println!("weather: {:.0}°C kode {} hujan_dalam {:?}", w.temp, w.code, w.rain_in);
                    // alert hujan hanya sekali per episode
                    let alert = w.rain_in.is_some() && !alerted;
                    alerted = w.rain_in.is_some();
                    let _ = app.emit("weather", (w, alert));
                    std::thread::sleep(Duration::from_secs(20 * 60));
                }
                Err(e) => {
                    eprintln!("weather gagal: {e}");
                    std::thread::sleep(Duration::from_secs(60));
                }
            }
        }
    });
}