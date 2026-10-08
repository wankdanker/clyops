// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::time::sleep;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScriptInfo {
    name: String,
    path: String,
    description: String,
}

/// Output of a clyops tool's `--help-json-schema` (spec/schema.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScriptSchema {
    /// Schema format version; its presence marks the program as a clyops tool.
    clyops: u32,
    script: String,
    /// Not part of the clyops schema: we fill it with the path we executed.
    #[serde(default)]
    path: String,
    description: String,
    epilog: String,
    arguments: Vec<Argument>,
    options: Vec<ScriptOption>,
    #[serde(rename = "requiredCommands")]
    required_commands: Vec<RequiredCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Argument {
    name: String,
    description: String,
    required: bool,
    #[serde(rename = "isVariadic")]
    is_variadic: bool,
    default: String,
    validation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScriptOption {
    name: String,
    #[serde(rename = "shortName")]
    short_name: String,
    #[serde(rename = "variableName")]
    variable_name: String,
    description: String,
    default: String,
    group: String,
    #[serde(rename = "type")]
    field_type: String,
    #[serde(rename = "isFlag")]
    is_flag: bool,
    #[serde(rename = "isArray")]
    is_array: bool,
    required: bool,
    validation: String,
    choices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RequiredCommand {
    command: String,
    description: String,
    #[serde(rename = "installHint")]
    install_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunningScript {
    id: String,
    name: String,
    pid: u32,
    started_at: String,
    args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
}

struct ProcessInfo {
    child: Child,
    name: String,
    args: Vec<String>,
    started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FormData {
    arguments: HashMap<String, String>,
    options: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Template {
    id: String,
    name: String,
    script: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(rename = "formData")]
    form_data: FormData,
}

/// Legacy template format for migration
#[derive(Debug, Clone, Deserialize)]
struct LegacyTemplate {
    name: String,
    script: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    arguments: HashMap<String, String>,
    #[serde(default)]
    options: HashMap<String, String>,
}

impl LegacyTemplate {
    fn migrate(self) -> Template {
        let id = sanitize_filename(&self.name);
        Template {
            id,
            name: self.name,
            script: self.script,
            description: self.description,
            created_at: Some(chrono::Utc::now().to_rfc3339()),
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            form_data: FormData {
                arguments: self.arguments.clone(),
                options: if self.options.is_empty() { self.arguments } else { self.options },
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppConfig {
    scripts_dir: Option<String>,
    templates_dir: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            scripts_dir: None,
            templates_dir: None,
        }
    }
}

struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, ProcessInfo>>>,
}

impl ProcessManager {
    fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn add_process(&self, id: String, process_info: ProcessInfo) {
        let mut processes = self.processes.lock().unwrap();
        processes.insert(id, process_info);
    }

    fn remove_process(&self, id: &str) -> std::option::Option<ProcessInfo> {
        let mut processes = self.processes.lock().unwrap();
        processes.remove(id)
    }

    fn get_running_scripts(&self) -> Vec<RunningScript> {
        let mut processes = self.processes.lock().unwrap();
        processes
            .iter_mut()
            .map(|(id, info)| {
                let pid = info.child.id();
                let (exit_code, finished_at) = match info.child.try_wait() {
                    Ok(Some(status)) => (
                        status.code(),
                        Some(chrono::Local::now().to_rfc3339()),
                    ),
                    _ => (None, None),
                };
                RunningScript {
                    id: id.clone(),
                    name: info.name.clone(),
                    pid,
                    started_at: info.started_at.clone(),
                    args: info.args.clone(),
                    exit_code,
                    finished_at,
                }
            })
            .collect()
    }

    fn check_and_notify_completed(&self, app_handle: &tauri::AppHandle) {
        let mut processes = self.processes.lock().unwrap();
        let mut completed = Vec::new();

        for (id, info) in processes.iter_mut() {
            if let Ok(Some(status)) = info.child.try_wait() {
                completed.push((id.clone(), status.code(), info.name.clone()));
            }
        }

        drop(processes);

        for (id, exit_code, name) in completed {
            let _ = app_handle.emit(
                &format!("process_completed_{}", id),
                serde_json::json!({
                    "id": id,
                    "exit_code": exit_code,
                    "name": name,
                }),
            );
            self.remove_process(&id);
        }
    }
}

/// Helper to resolve templates directory with priority: env var → config → default
fn resolve_templates_dir(app: &tauri::AppHandle) -> PathBuf {
    // 1. Check CLYOPS_RUNNER_TEMPLATES_DIR environment variable
    if let Ok(env_dir) = std::env::var("CLYOPS_RUNNER_TEMPLATES_DIR") {
        if !env_dir.is_empty() {
            let path = PathBuf::from(&env_dir);
            // Create if doesn't exist
            let _ = std::fs::create_dir_all(&path);
            return path;
        }
    }

    // 2. Check saved config
    let config_dir = app.path()
        .app_config_dir()
        .expect("Failed to get config directory");
    
    let config_file = config_dir.join("config.json");
    if config_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_file) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                if let Some(templates_dir) = config.templates_dir {
                    if !templates_dir.is_empty() {
                        let path = PathBuf::from(&templates_dir);
                        // Create if doesn't exist
                        let _ = std::fs::create_dir_all(&path);
                        return path;
                    }
                }
            }
        }
    }

    // 3. Default to app data dir
    let default_dir = app.path()
        .app_data_dir()
        .expect("Failed to get data directory")
        .join("templates");
    
    let _ = std::fs::create_dir_all(&default_dir);
    default_dir
}

#[tauri::command]
fn get_templates_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = resolve_templates_dir(&app);
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn get_scripts_dir(app: tauri::AppHandle) -> Result<String, String> {
    // Priority: 1. CLYOPS_RUNNER_DIR env var, 2. Saved config

    // Check CLYOPS_RUNNER_DIR environment variable first
    if let Ok(env_dir) = std::env::var("CLYOPS_RUNNER_DIR") {
        if !env_dir.is_empty() && PathBuf::from(&env_dir).exists() {
            return Ok(env_dir);
        }
    }
    
    // Check saved config
    let config_dir = app.path()
        .app_config_dir()
        .expect("Failed to get config directory");
    
    let config_file = config_dir.join("config.json");
    if config_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_file) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                if let Some(scripts_dir) = config.scripts_dir {
                    if PathBuf::from(&scripts_dir).exists() {
                        return Ok(scripts_dir);
                    }
                }
            }
        }
    }
    
    Err("Tools directory not set. Choose one in settings or set CLYOPS_RUNNER_DIR.".to_string())
}

/// Executable files are candidate tools; whether one is a clyops tool is
/// decided when its schema is read.
#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &std::path::Path) -> bool {
    path.is_file()
}

#[tauri::command]
fn discover_scripts(scripts_dir: String) -> Result<Vec<ScriptInfo>, String> {
    let path = PathBuf::from(&scripts_dir);

    if !path.exists() {
        return Err(format!("Scripts directory not found: {}", scripts_dir));
    }

    let mut scripts = Vec::new();

    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if is_executable(&path) {
            if let Some(name) = path.file_name() {
                let name_str = name.to_string_lossy().to_string();

                // Skip hidden files
                if name_str.starts_with('.') {
                    continue;
                }

                scripts.push(ScriptInfo {
                    name: name_str.clone(),
                    path: path.to_string_lossy().to_string(),
                    description: format!("Script: {}", name_str),
                });
            }
        }
    }

    scripts.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(scripts)
}

#[tauri::command]
fn get_script_schema(script_path: String) -> Result<ScriptSchema, String> {
    // Execute the tool directly with --help-json-schema
    let output = Command::new(&script_path)
        .arg("--help-json-schema")
        .current_dir(std::path::Path::new(&script_path).parent().unwrap())
        .output()
        .map_err(|e| format!("Failed to execute script: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Script failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    parse_schema(&String::from_utf8_lossy(&output.stdout), &script_path)
}

fn parse_schema(json: &str, script_path: &str) -> Result<ScriptSchema, String> {
    let mut schema: ScriptSchema = serde_json::from_str(json)
        .map_err(|e| format!("Not a clyops tool (could not read its --help-json-schema output): {}", e))?;
    if schema.clyops != 1 {
        return Err(format!("Unsupported clyops schema version {}", schema.clyops));
    }
    schema.path = script_path.to_string();
    Ok(schema)
}

#[tauri::command]
async fn run_script(
    script_path: String,
    args: Vec<String>,
    process_manager: State<'_, ProcessManager>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let script_name = std::path::Path::new(&script_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let script_dir = std::path::Path::new(&script_path)
        .parent()
        .ok_or("Invalid script path")?;

    let mut child = Command::new(&script_path)
        .args(&args)
        .current_dir(script_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    // Take ownership of stdout and stderr
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let started_at = chrono::Local::now().to_rfc3339();

    let process_info = ProcessInfo {
        child,
        name: script_name,
        args: args.clone(),
        started_at,
    };

    process_manager.add_process(id.clone(), process_info);

    // Spawn thread to read stdout
    if let Some(stdout) = stdout {
        let id_clone = id.clone();
        let app_clone = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("Emitting stdout for {}: {}", id_clone, line);
                    let event_name = format!("output_{}", id_clone);
                    if let Err(e) = app_clone.emit(
                        &event_name,
                        serde_json::json!({
                            "id": id_clone,
                            "type": "stdout",
                            "data": line,
                        }),
                    ) {
                        eprintln!("Failed to emit stdout event: {}", e);
                    }
                }
            }
            println!("Stdout reader thread finished for {}", id_clone);
        });
    }
    
    // Spawn thread to read stderr
    if let Some(stderr) = stderr {
        let id_clone = id.clone();
        let app_clone = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("Emitting stderr for {}: {}", id_clone, line);
                    let event_name = format!("output_{}", id_clone);
                    if let Err(e) = app_clone.emit(
                        &event_name,
                        serde_json::json!({
                            "id": id_clone,
                            "type": "stderr",
                            "data": line,
                        }),
                    ) {
                        eprintln!("Failed to emit stderr event: {}", e);
                    }
                }
            }
            println!("Stderr reader thread finished for {}", id_clone);
        });
    }

    Ok(id)
}

#[tauri::command]
async fn stop_script(
    id: String,
    process_manager: State<'_, ProcessManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(mut process_info) = process_manager.remove_process(&id) {
        let pid = process_info.child.id();

        // Try SIGTERM first for graceful shutdown
        #[cfg(unix)]
        {
            use std::process::Command as StdCommand;
            let _ = StdCommand::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .output();

            // Wait up to 5 seconds for graceful shutdown
            for _ in 0..10 {
                match process_info.child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = app.emit(
                            &format!("process_completed_{}", id),
                            serde_json::json!({
                                "id": id,
                                "exit_code": status.code(),
                                "name": process_info.name,
                            }),
                        );
                        return Ok(());
                    }
                    _ => {
                        sleep(Duration::from_millis(500)).await;
                    }
                }
            }
        }

        // Force kill if still running
        process_info
            .child
            .kill()
            .map_err(|e| format!("Failed to kill process: {}", e))?;

        let _ = app.emit(
            &format!("process_completed_{}", id),
            serde_json::json!({
                "id": id,
                "exit_code": null,
                "name": process_info.name,
            }),
        );

        Ok(())
    } else {
        Err(format!("Process not found: {}", id))
    }
}

#[tauri::command]
async fn get_running_scripts(
    process_manager: State<'_, ProcessManager>,
) -> Result<Vec<RunningScript>, String> {
    Ok(process_manager.get_running_scripts())
}



#[tauri::command]
fn save_template(app: tauri::AppHandle, template: Template) -> Result<Template, String> {
    let data_dir = resolve_templates_dir(&app);

    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    // Use the template id for the filename (sanitized)
    let template_file = data_dir.join(format!("{}.json", template.id));
    
    // Add timestamps
    let now = chrono::Utc::now().to_rfc3339();
    let mut saved_template = template.clone();
    if saved_template.created_at.is_none() {
        saved_template.created_at = Some(now.clone());
    }
    saved_template.updated_at = Some(now);
    
    let json = serde_json::to_string_pretty(&saved_template).map_err(|e| e.to_string())?;
    std::fs::write(template_file, json).map_err(|e| e.to_string())?;

    Ok(saved_template)
}

#[tauri::command]
fn load_templates(app: tauri::AppHandle) -> Result<Vec<Template>, String> {
    let data_dir = resolve_templates_dir(&app);

    if !data_dir.exists() {
        return Ok(vec![]);
    }

    let mut templates = Vec::new();

    for entry in std::fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            
            // Try to parse as new format first
            let template: Template = match serde_json::from_str(&content) {
                Ok(t) => t,
                Err(_) => {
                    // Try legacy format and migrate
                    let legacy: LegacyTemplate = serde_json::from_str(&content)
                        .map_err(|e| format!("Failed to parse template {:?}: {}", path, e))?;
                    let migrated = legacy.migrate();
                    
                    // Save the migrated template
                    let new_path = data_dir.join(format!("{}.json", migrated.id));
                    let json = serde_json::to_string_pretty(&migrated).map_err(|e| e.to_string())?;
                    std::fs::write(&new_path, json).map_err(|e| e.to_string())?;
                    
                    // Delete old file if it has a different name
                    if new_path != path {
                        let _ = std::fs::remove_file(&path);
                    }
                    
                    migrated
                }
            };
            templates.push(template);
        }
    }

    Ok(templates)
}

#[tauri::command]
fn delete_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let data_dir = resolve_templates_dir(&app);

    let template_file = data_dir.join(format!("{}.json", id));

    if template_file.exists() {
        std::fs::remove_file(template_file).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn rename_template(app: tauri::AppHandle, id: String, new_name: String) -> Result<Template, String> {
    let data_dir = resolve_templates_dir(&app);

    let template_file = data_dir.join(format!("{}.json", id));

    if !template_file.exists() {
        return Err(format!("Template not found: {}", id));
    }

    // Read existing template
    let content = std::fs::read_to_string(&template_file).map_err(|e| e.to_string())?;
    let mut template: Template = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Generate new id from new name
    let new_id = sanitize_filename(&new_name);
    let new_template_file = data_dir.join(format!("{}.json", new_id));

    // Check if new id already exists (and is different from current)
    if new_id != id && new_template_file.exists() {
        return Err(format!("A template with name '{}' already exists", new_name));
    }

    // Update template
    template.id = new_id.clone();
    template.name = new_name;
    template.updated_at = Some(chrono::Utc::now().to_rfc3339());

    // Write to new file
    let json = serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?;
    std::fs::write(&new_template_file, json).map_err(|e| e.to_string())?;

    // Delete old file if id changed
    if new_id != id {
        std::fs::remove_file(&template_file).map_err(|e| e.to_string())?;
    }

    Ok(template)
}

/// Sanitize a string to be used as a filename
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '_'
            } else {
                '_'
            }
        })
        .collect::<String>()
        .to_lowercase()
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let config_dir = app.path()
        .app_config_dir()
        .expect("Failed to get config directory");
    
    let config_file = config_dir.join("config.json");
    
    if config_file.exists() {
        let content = std::fs::read_to_string(&config_file).map_err(|e| e.to_string())?;
        let config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(config)
    } else {
        Ok(AppConfig::default())
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let config_dir = app.path()
        .app_config_dir()
        .expect("Failed to get config directory");
    
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    
    let config_file = config_dir.join("config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_file, json).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tokio::main]
async fn main() {
    let process_manager = ProcessManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(process_manager)
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Spawn background task to monitor processes
            let app_handle_clone = app_handle.clone();
            tokio::spawn(async move {
                loop {
                    if let Some(pm_state) = app_handle_clone.try_state::<ProcessManager>() {
                        pm_state.check_and_notify_completed(&app_handle_clone);
                    }
                    sleep(Duration::from_secs(1)).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_scripts_dir,
            discover_scripts,
            get_script_schema,
            run_script,
            stop_script,
            get_running_scripts,
            save_template,
            load_templates,
            delete_template,
            rename_template,
            get_templates_dir,
            get_config,
            save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The runner must accept the schema every clyops implementation emits.
    #[test]
    fn parses_the_conformance_schema() {
        let json = include_str!("../../../../spec/conformance/golden/schema.json");
        let schema = parse_schema(json, "/tools/demo").expect("golden schema parses");
        assert_eq!(schema.script, "demo");
        assert_eq!(schema.path, "/tools/demo");
        assert!(schema.arguments.iter().any(|a| a.name == "rest" && a.is_variadic));
        assert!(schema.options.iter().any(|o| o.name == "key" && o.required));
        assert!(schema.options.iter().any(|o| o.name == "tag" && o.is_array));
    }

    /// Discover and load a real clyops tool: the C conformance demo
    /// (build it first with `make -C packages/c`).
    #[test]
    fn loads_a_real_clyops_tool() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/c/build");
        let dir = dir.canonicalize().expect("packages/c/build exists; run `make -C packages/c` first");
        let tools = discover_scripts(dir.to_string_lossy().into_owned()).expect("discovery works");
        let demo = tools.iter().find(|t| t.name == "demo").expect("demo is discovered");
        assert!(!tools.iter().any(|t| t.name == "libclyops.a"), "non-executables are skipped");

        let schema = get_script_schema(demo.path.clone()).expect("demo answers --help-json-schema");
        assert_eq!(schema.script, "demo");
        assert_eq!(schema.path, demo.path);
        assert_eq!(schema.options.len(), 27);
    }

    #[test]
    fn rejects_non_clyops_output() {
        assert!(parse_schema(r#"{"script": "x"}"#, "/x").unwrap_err().starts_with("Not a clyops tool"));
    }
}
