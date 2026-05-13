use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    webview::{NewWindowFeatures, NewWindowResponse},
    AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry,
};
use url::Url;

const CONFIG_FILE_NAME: &str = "connection.json";

const BROWSER_ARGS: &str =
    "--ignore-certificate-errors \
     --disable-features=msSmartScreenProtection \
     --enable-features=OverlayScrollbar,FluentOverlayScrollbar";

#[derive(Default)]
struct AppStateInner {
    server_base_url: Option<String>,
    pending_error: Option<String>,
}

type AppState = Mutex<AppStateInner>;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedConnection {
    host: String,
    port: u16,
    use_tls: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve config dir: {e}"))?;
    Ok(dir.join(CONFIG_FILE_NAME))
}

#[tauri::command]
fn get_saved_connection(app: AppHandle) -> Option<SavedConnection> {
    let path = config_path(&app).ok()?;
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<SavedConnection>(&raw).ok()
}

#[tauri::command]
fn get_pending_error(state: State<'_, AppState>) -> Option<String> {
    let mut s = state.lock().ok()?;
    s.pending_error.take()
}

#[tauri::command]
async fn connect_to_server(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: u16,
    use_tls: bool,
) -> Result<ConnectResult, String> {
    let trimmed = host.trim().to_string();
    if trimmed.is_empty() {
        return Ok(ConnectResult {
            success: false,
            error: Some("Host is required".into()),
        });
    }
    if port == 0 {
        return Ok(ConnectResult {
            success: false,
            error: Some("Port must be between 1 and 65535".into()),
        });
    }

    let scheme = if use_tls { "https" } else { "http" };
    let url = format!("{scheme}://{trimmed}:{port}");

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    if client.get(&url).send().await.is_err() {
        return Ok(ConnectResult {
            success: false,
            error: Some(
                "Cannot reach the Overlord server at that address. \
                 Make sure the server is running before connecting — \
                 see the README for setup instructions."
                    .into(),
            ),
        });
    }

    let saved = SavedConnection {
        host: trimmed,
        port,
        use_tls,
    };
    save_connection(&app, &saved).map_err(|e| e.to_string())?;

    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.server_base_url = Some(url.clone());
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    window.navigate(parsed).map_err(|e| e.to_string())?;

    Ok(ConnectResult {
        success: true,
        error: None,
    })
}

#[tauri::command]
fn go_back_to_connect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.server_base_url = None;
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .eval("window.location.replace('index.html')")
        .map_err(|e| e.to_string())
}

fn save_connection(app: &AppHandle, conn: &SavedConnection) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(conn).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn icon_image() -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/icon.png")).ok()
}

fn unique_label(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos}")
}

fn handle_new_window(
    app: AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<Wry> {
    let label = unique_label("popup");
    eprintln!("[overlord] on_new_window: label={label} url={url}");

    let blank = Url::parse("about:blank").expect("about:blank parses");
    let popup_app = app.clone();
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(blank))
        .title(url.as_str())
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .additional_browser_args(BROWSER_ARGS)
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_new_window(move |u, f| handle_new_window(popup_app.clone(), u, f));

    match builder.build() {
        Ok(window) => {
            if let Some(icon) = icon_image() {
                let _ = window.set_icon(icon);
            }
            NewWindowResponse::Create { window }
        }
        Err(e) => {
            eprintln!("[overlord] on_new_window: build failed: {e}");
            NewWindowResponse::Deny
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_saved_connection,
            get_pending_error,
            connect_to_server,
            go_back_to_connect,
        ])
        .setup(|app| {
            let handler_app = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Overlord")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(900.0, 600.0)
                    .resizable(true)
                    .additional_browser_args(BROWSER_ARGS)
                    .on_new_window(move |url, features| {
                        handle_new_window(handler_app.clone(), url, features)
                    })
                    .build()?;

            if let Some(icon) = icon_image() {
                let _ = window.set_icon(icon);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
