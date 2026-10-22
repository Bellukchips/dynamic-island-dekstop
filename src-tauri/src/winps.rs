//! Satu proses PowerShell bersama untuk semua pemantau Windows
//! (perangkat USB/jack, kecerahan, Bluetooth).
//!
//! Sebelumnya tiap pemantau menjalankan PowerShell sendiri-sendiri; satu proses
//! PowerShell memakai puluhan MB, jadi digabung menjadi satu. Skrip mencetak baris
//! berawalan tag ("H:", "D:", "T:") dan dibagikan ke pelanggan yang sesuai.
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

const NO_WINDOW: u32 = 0x0800_0000;

static SUBS: Mutex<Vec<(&'static str, mpsc::Sender<String>)>> = Mutex::new(Vec::new());

// Daftarkan diri SEBELUM start() dipanggil. Baris yang diterima sudah tanpa tag.
pub fn subscribe(tag: &'static str) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    SUBS.lock().unwrap_or_else(|e| e.into_inner()).push((tag, tx));
    rx
}

// H: kecerahan layar          tiap putaran (~0,7 dtk)
// D: perangkat USB + jack     tiap 3 putaran, diakhiri "D:---"
// T: Bluetooth terhubung      tiap 4 putaran, diakhiri "T:---"
//   {83DA6326-...} 15 = DEVPKEY_Device_IsConnected
//   {104EA319-...} 2  = tingkat baterai perangkat Bluetooth (jika dilaporkan)
const SCRIPT: &str = r##"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$mm = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$conn = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
$batt = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
$i = 0
while ($true) {
  $br = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness
  if ($br -ne $null) { 'H:B|' + $br }

  if ($i % 3 -eq 0) {
    Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\VID_*' } |
      ForEach-Object { 'D:' + $_.InstanceId + '|' + $_.Class + '|' + $_.FriendlyName }

    # jack 3.5mm: endpoint render aktif (DeviceState = 1) bernama headphone/headset
    Get-ChildItem $mm | ForEach-Object {
      $st = (Get-ItemProperty $_.PSPath).DeviceState
      if ($st -eq 1) {
        $p = Get-ItemProperty ($_.PSPath + '\Properties')
        $desc = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
        $adapter = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
        if (($desc -match 'Headphone|Headset|Earphone|Earbud|Handset') -and ($adapter -notmatch 'USB|Bluetooth|Hands-Free')) {
          'D:JACK|' + $desc + ' (' + $adapter + ')'
        }
      }
    }
    'D:---'
  }

  if ($i % 4 -eq 0) {
    Get-PnpDevice -Class Bluetooth -PresentOnly | Where-Object {
      $_.InstanceId -like 'BTHENUM\DEV_*' -or $_.InstanceId -like 'BTHLE\DEV_*'
    } | ForEach-Object {
      $id = $_.InstanceId
      $c = (Get-PnpDeviceProperty -InstanceId $id -KeyName $conn).Data
      if ($c -eq $true) {
        $bl = (Get-PnpDeviceProperty -InstanceId $id -KeyName $batt).Data
        'T:BT|' + $id + '|' + $bl + '|' + $_.FriendlyName
      }
    }
    'T:---'
  }

  $i = ($i + 1) % 12
  Start-Sleep -Milliseconds 700
}
"##;

fn run() {
    let subs = SUBS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let child = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        eprintln!("winps: PowerShell gagal dijalankan");
        return;
    };
    let Some(out) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };

    for line in BufReader::new(out).lines().map_while(Result::ok) {
        if let Some((tag, rest)) = line.split_once(':') {
            for (t, tx) in &subs {
                if *t == tag {
                    let _ = tx.send(rest.to_string());
                }
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

// Panggil SETELAH semua modul mendaftar lewat subscribe().
pub fn start() {
    std::thread::spawn(|| loop {
        run();
        // PowerShell berhenti: coba lagi nanti
        std::thread::sleep(Duration::from_secs(10));
    });
}