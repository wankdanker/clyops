//! clyops — declarative CLI parsing. Behavior follows `spec/SPEC.md`.
//!
//! ```no_run
//! use clyops::Cli;
//!
//! let mut cli = Cli::new();
//! cli.arg("input", "Input file", "", "path");
//! cli.opt("PORT", "port", "p", "8080", "Server port").group("Network").rule("port");
//! cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output");
//! let args = cli.run();
//! println!("{} {} {}", args.str("input"), args.int("PORT"), args.bool("VERBOSE"));
//! ```

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::{IsTerminal, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// A resolved, typed value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Value>),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        if let Value::Str(s) = self {
            Some(s)
        } else {
            None
        }
    }
    pub fn as_int(&self) -> Option<i64> {
        if let Value::Int(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub fn as_float(&self) -> Option<f64> {
        match self {
            Value::Float(f) => Some(*f),
            Value::Int(n) => Some(*n as f64),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
    pub fn as_list(&self) -> &[Value] {
        if let Value::List(l) = self {
            l
        } else {
            &[]
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

/// Resolved values keyed by option var and argument name, in registration order.
#[derive(Debug, Clone, Default)]
pub struct Values(Vec<(String, Value)>);

static NULL: Value = Value::Null;

impl Values {
    /// The value for `name`, or `Value::Null` when unknown or unset.
    pub fn get(&self, name: &str) -> &Value {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v).unwrap_or(&NULL)
    }
    /// String value, or "" when unset.
    pub fn str(&self, name: &str) -> &str {
        self.get(name).as_str().unwrap_or("")
    }
    /// Integer value (int*/port rules), or 0 when unset.
    pub fn int(&self, name: &str) -> i64 {
        self.get(name).as_int().unwrap_or(0)
    }
    /// Number value (float*/int* rules), or 0.0 when unset.
    pub fn float(&self, name: &str) -> f64 {
        self.get(name).as_float().unwrap_or(0.0)
    }
    /// Boolean value (flags, bool rule), or false when unset.
    pub fn bool(&self, name: &str) -> bool {
        self.get(name).as_bool().unwrap_or(false)
    }
    /// List of strings (array options, variadics).
    pub fn strs(&self, name: &str) -> Vec<&str> {
        self.get(name).as_list().iter().filter_map(Value::as_str).collect()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
    fn set(&mut self, name: &str, value: Value) {
        self.0.push((name.to_string(), value));
    }
}

// ---------------------------------------------------------------------------
// Minimal JSON writer (pretty, two-space indent)
// ---------------------------------------------------------------------------

enum Json {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
    Map(Vec<(String, Json)>),
}

fn json_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl Json {
    fn render(&self, depth: usize, out: &mut String) {
        let pad = |d: usize, out: &mut String| out.push_str(&"  ".repeat(d));
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => out.push_str(n),
            Json::Str(s) => json_str(s, out),
            Json::Arr(items) if items.is_empty() => out.push_str("[]"),
            Json::Arr(items) => {
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    pad(depth + 1, out);
                    item.render(depth + 1, out);
                    out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
                }
                pad(depth, out);
                out.push(']');
            }
            Json::Obj(_) | Json::Map(_) => {
                let entries: Vec<(&str, &Json)> = match self {
                    Json::Obj(e) => e.iter().map(|(k, v)| (*k, v)).collect(),
                    Json::Map(e) => e.iter().map(|(k, v)| (k.as_str(), v)).collect(),
                    _ => unreachable!(),
                };
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (i, (k, v)) in entries.iter().enumerate() {
                    pad(depth + 1, out);
                    json_str(k, out);
                    out.push_str(": ");
                    v.render(depth + 1, out);
                    out.push_str(if i + 1 < entries.len() { ",\n" } else { "\n" });
                }
                pad(depth, out);
                out.push('}');
            }
        }
    }

    fn pretty(&self) -> String {
        let mut out = String::new();
        self.render(0, &mut out);
        out
    }

    fn from_value(v: &Value) -> Json {
        match v {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Int(n) => Json::Num(n.to_string()),
            Value::Float(f) => Json::Num(if f.is_finite() { format!("{f}") } else { "null".into() }),
            Value::Str(s) => Json::Str(s.clone()),
            Value::List(l) => Json::Arr(l.iter().map(Json::from_value).collect()),
        }
    }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

static SILENT: AtomicBool = AtomicBool::new(false);

/// Suppress info/warn/error/success output (die and parse errors still print).
pub fn set_silent(value: bool) {
    SILENT.store(value, Ordering::Relaxed);
}

#[cfg(unix)]
fn timestamp() -> String {
    // Local time via the C library; the leading fields of `struct tm` are the
    // same on every Unix we target.
    #[repr(C)]
    struct Tm {
        sec: i32,
        min: i32,
        hour: i32,
        mday: i32,
        mon: i32,
        year: i32,
        wday: i32,
        yday: i32,
        isdst: i32,
        gmtoff: i64,
        zone: *const i8,
    }
    extern "C" {
        fn time(t: *mut i64) -> i64;
        fn localtime_r(t: *const i64, tm: *mut Tm) -> *mut Tm;
    }
    let mut tm =
        Tm { sec: 0, min: 0, hour: 0, mday: 0, mon: 0, year: 0, wday: 0, yday: 0, isdst: 0, gmtoff: 0, zone: std::ptr::null() };
    unsafe {
        let now = time(std::ptr::null_mut());
        localtime_r(&now, &mut tm);
    }
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", tm.year + 1900, tm.mon + 1, tm.mday, tm.hour, tm.min, tm.sec)
}

#[cfg(not(unix))]
fn timestamp() -> String {
    // UTC without a date library: civil-from-days (Howard Hinnant).
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem / 60 % 60, rem % 60)
}

fn emit(level: &str, msg: &str, force: bool) {
    if !force && (SILENT.load(Ordering::Relaxed) || std::env::var("CLYOPS_SILENT").as_deref() == Ok("true")) {
        return;
    }
    let mut tag = level.to_string();
    if std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none() {
        let color = match level {
            "info" => "1;37",
            "warning" => "0;33",
            "success" => "0;32",
            _ => "0;31",
        };
        tag = format!("\x1b[{color}m{level}\x1b[0m");
    }
    let _ = writeln!(std::io::stderr(), "{} [{}] {}", timestamp(), tag, msg);
}

pub fn info(msg: &str) {
    emit("info", msg, false)
}
pub fn warn(msg: &str) {
    emit("warning", msg, false)
}
pub fn error(msg: &str) {
    emit("error", msg, false)
}
pub fn success(msg: &str) {
    emit("success", msg, false)
}

/// Print an error and exit with `code`. Never suppressed.
pub fn die(code: i32, msg: &str) -> ! {
    emit("error", msg, true);
    std::process::exit(code)
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("built-in pattern")
}

fn full(pattern: &str, value: &str) -> bool {
    re(&format!("^(?:{pattern})$")).is_match(value)
}

fn bool_word(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" | "on" => Some(true),
        "false" | "no" | "0" | "off" => Some(false),
        _ => None,
    }
}

const FIXED_RULES: &[&str] = &[
    "int",
    "float",
    "string",
    "path",
    "ip",
    "hostname",
    "url",
    "port",
    "email",
    "uuid",
    "bool",
    "date:YYYY-MM-DD",
    "file:exists",
    "file:readable",
    "file:writable",
    "dir:exists",
    "dir:writable",
];

fn known_rule(rule: &str) -> bool {
    rule.is_empty()
        || FIXED_RULES.contains(&rule)
        || full(r"int:(\d+-\d*|-\d+)", rule)
        || full(r"float:(\d*\.?\d+-(\d*\.?\d+)?|-\d*\.?\d+)", rule)
        || full(r"string:(\d+|\d+-\d*|-\d+)", rule)
        || (rule.starts_with("choice:") && rule.len() > 7)
        || (rule.starts_with("regex:") && rule.len() > 6 && Regex::new(&rule[6..]).is_ok())
}

fn bounds(rule: &str) -> (&str, &str) {
    let range = &rule[rule.find(':').map_or(0, |i| i + 1)..];
    range.split_once('-').unwrap_or((range, ""))
}

fn is_path_rule(rule: &str) -> bool {
    rule == "path" || rule.starts_with("file:") || rule.starts_with("dir:")
}

/// Help text for a validation rule (spec section 5).
pub fn describe_rule(rule: &str) -> String {
    let fixed = match rule {
        "int" => "integer",
        "float" => "number",
        "string" => "text",
        "path" => "path",
        "ip" => "IP address",
        "hostname" => "hostname",
        "url" => "URL",
        "port" => "port: 1-65535",
        "email" => "email address",
        "uuid" => "UUID",
        "bool" => "true/false, yes/no, 1/0, on/off",
        "date:YYYY-MM-DD" => "date: YYYY-MM-DD",
        "file:exists" => "existing file",
        "file:readable" => "readable file",
        "file:writable" => "writable file",
        "dir:exists" => "existing directory",
        "dir:writable" => "writable directory",
        _ => "",
    };
    if !fixed.is_empty() {
        return fixed.to_string();
    }
    for (prefix, noun, suffix) in [("int:", "integer", ""), ("float:", "number", ""), ("string:", "text", " chars")] {
        if let Some(range) = rule.strip_prefix(prefix) {
            if !range.contains('-') {
                return format!("{noun}: {range}{suffix}");
            }
            let (lo, hi) = bounds(rule);
            return match (lo.is_empty(), hi.is_empty()) {
                (false, false) => format!("{noun}: {lo}-{hi}{suffix}"),
                (false, true) => format!("{noun}: >={lo}{suffix}"),
                _ => format!("{noun}: <={hi}{suffix}"),
            };
        }
    }
    if let Some(c) = rule.strip_prefix("choice:") {
        return format!("choices: {}", c.split(',').collect::<Vec<_>>().join(", "));
    }
    if let Some(p) = rule.strip_prefix("regex:") {
        return format!("pattern: {p}");
    }
    rule.to_string()
}

#[cfg(unix)]
fn access(path: &str, mode: i32) -> bool {
    extern "C" {
        fn access(path: *const std::os::raw::c_char, mode: std::os::raw::c_int) -> std::os::raw::c_int;
    }
    match std::ffi::CString::new(path) {
        Ok(c) => unsafe { access(c.as_ptr(), mode) == 0 },
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn access(path: &str, mode: i32) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => mode != W_OK || !m.permissions().readonly(),
        Err(_) => false,
    }
}

const R_OK: i32 = 4;
const W_OK: i32 = 2;

/// Validate `value` against `rule` and convert it to its typed form.
/// The error is the spec's error text.
pub fn validate(value: &str, rule: &str, name: &str) -> Result<Value, String> {
    let fail = |msg: String| Err(format!("{name} {msg}"));
    let check_bounds = |num: f64, (lo, hi): (&str, &str)| -> Result<(), String> {
        if !lo.is_empty() && num < lo.parse::<f64>().unwrap_or(f64::MIN) {
            return Err(format!("{name} must be >= {lo}, got {value}"));
        }
        if !hi.is_empty() && num > hi.parse::<f64>().unwrap_or(f64::MAX) {
            return Err(format!("{name} must be <= {hi}, got {value}"));
        }
        Ok(())
    };

    if rule == "int" || rule.starts_with("int:") {
        if !full("-?[0-9]+", value) {
            return fail(format!("must be an integer, got '{value}'"));
        }
        let num: i64 = value.parse().map_err(|_| format!("{name} must be an integer, got '{value}'"))?;
        if rule != "int" {
            check_bounds(num as f64, bounds(rule))?;
        }
        return Ok(Value::Int(num));
    }
    if rule == "float" || rule.starts_with("float:") {
        if !full(r"-?[0-9]*\.?[0-9]+", value) {
            return fail(format!("must be a number, got '{value}'"));
        }
        let num: f64 = value.parse().unwrap_or(0.0);
        if rule != "float" {
            check_bounds(num, bounds(rule))?;
        }
        return Ok(Value::Float(num));
    }
    if let Some(spec) = rule.strip_prefix("string:") {
        let len = value.chars().count();
        if !spec.contains('-') {
            if len != spec.parse::<usize>().unwrap_or(0) {
                return fail(format!("must be exactly {spec} characters, got {len}"));
            }
        } else {
            let (lo, hi) = bounds(rule);
            if !lo.is_empty() && len < lo.parse().unwrap_or(0) {
                return fail(format!("must be at least {lo} characters, got {len}"));
            }
            if !hi.is_empty() && len > hi.parse().unwrap_or(usize::MAX) {
                return fail(format!("must be at most {hi} characters, got {len}"));
            }
        }
        return Ok(Value::Str(value.into()));
    }
    if let Some(choices) = rule.strip_prefix("choice:") {
        if !choices.split(',').any(|c| c == value) {
            return fail(format!("must be one of: {}, got '{value}'", choices.split(',').collect::<Vec<_>>().join(", ")));
        }
        return Ok(Value::Str(value.into()));
    }
    if let Some(pattern) = rule.strip_prefix("regex:") {
        if !re(pattern).is_match(value) {
            return fail(format!("does not match required pattern, got '{value}'"));
        }
        return Ok(Value::Str(value.into()));
    }

    let ok = match rule {
        "bool" => {
            return match bool_word(value) {
                Some(b) => Ok(Value::Bool(b)),
                None => fail(format!("must be a boolean (true/false, yes/no, 1/0, on/off), got '{value}'")),
            }
        }
        "port" => {
            return match value.parse::<i64>() {
                Ok(p) if full("[0-9]+", value) && (1..=65535).contains(&p) => Ok(Value::Int(p)),
                _ => fail(format!("must be a valid port (1-65535), got '{value}'")),
            }
        }
        "ip" => full(r"([0-9]{1,3}\.){3}[0-9]{1,3}", value) || full("([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}", value),
        "hostname" => full(r"[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*", value),
        "url" => full(r"https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/(?s:.)*)?", value),
        "email" => full(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", value),
        "uuid" => full("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", value),
        "date:YYYY-MM-DD" => full("[0-9]{4}-[0-9]{2}-[0-9]{2}", value),
        _ => true,
    };
    if !ok {
        let what = match rule {
            "ip" => "must be a valid IP address".to_string(),
            "hostname" => "must be a valid hostname".to_string(),
            "url" => "must be a valid URL".to_string(),
            "email" => "must be a valid email address".to_string(),
            "uuid" => "must be a valid UUID".to_string(),
            _ => "must be in YYYY-MM-DD format".to_string(),
        };
        return fail(format!("{what}, got '{value}'"));
    }

    let p = Path::new(value);
    match rule {
        "file:exists" if !p.is_file() => return fail(format!("file does not exist: {value}")),
        "file:readable" if !access(value, R_OK) => return fail(format!("file is not readable: {value}")),
        "file:writable" => {
            if p.symlink_metadata().is_ok() {
                if !access(value, W_OK) {
                    return fail(format!("file is not writable: {value}"));
                }
            } else {
                let dir = dirname(value);
                if !Path::new(&dir).is_dir() || !access(&dir, W_OK) {
                    return fail(format!("directory is not writable: {dir}"));
                }
            }
        }
        "dir:exists" if !p.is_dir() => return fail(format!("directory does not exist: {value}")),
        "dir:writable" if !p.is_dir() || !access(value, W_OK) => {
            return fail(format!("directory does not exist or is not writable: {value}"))
        }
        _ => {}
    }
    Ok(Value::Str(value.into()))
}

fn dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => path[..i].into(),
        None => ".".into(),
    }
}

/// Lexically join and normalize (no symlink resolution).
fn join_norm(base: &str, value: &str) -> String {
    let joined = if value.starts_with('/') { value.to_string() } else { format!("{base}/{value}") };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Resolve a path value against `base` (spec section 6).
pub fn resolve_path(value: &str, base: &str, search_dirs: &[String]) -> String {
    if value.is_empty() || ["-", "disabled", "optional"].contains(&value) || value.starts_with('/') {
        return value.to_string();
    }
    if re("^[A-Za-z][A-Za-z0-9+.-]+:").is_match(value) {
        return value.to_string();
    }
    let from_base = join_norm(base, value);
    let bare = !(value == "." || value == ".." || value.starts_with("./") || value.starts_with("../"));
    if bare && !search_dirs.is_empty() && !Path::new(&from_base).exists() {
        for dir in search_dirs {
            let candidate = join_norm(dir, value);
            if Path::new(&candidate).exists() {
                return candidate;
            }
        }
    }
    from_base
}

/// Greedy word wrap that keeps existing line breaks (spec section 7).
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for original in text.split('\n') {
        let original = original.strip_suffix('\r').unwrap_or(original);
        let mut line = String::new();
        let mut any = false;
        for word in original.split_whitespace() {
            any = true;
            if line.is_empty() {
                line = word.to_string();
            } else if line.chars().count() + 1 + word.chars().count() <= width {
                line.push(' ');
                line.push_str(word);
            } else {
                out.push(std::mem::replace(&mut line, word.to_string()));
            }
        }
        out.push(if any { line } else { String::new() });
    }
    out
}

fn command_available(cmd: &str, path_var: &str) -> bool {
    let is_exec = |p: &Path| -> bool {
        match p.metadata() {
            #[cfg(unix)]
            Ok(m) => m.is_file() && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0,
            #[cfg(not(unix))]
            Ok(m) => m.is_file(),
            Err(_) => false,
        }
    };
    if cmd.contains('/') {
        return is_exec(Path::new(cmd));
    }
    std::env::split_paths(path_var).any(|dir| is_exec(&dir.join(cmd)))
}

fn completion_kind(rule: &str, dirs: &[String]) -> (&'static str, String) {
    if rule == "path" || rule.starts_with("file:") {
        ("file", dirs.join(":"))
    } else if rule.starts_with("dir:") {
        ("dir", dirs.join(":"))
    } else if let Some(c) = rule.strip_prefix("choice:") {
        ("choice", c.to_string())
    } else if rule == "bool" {
        ("choice", "true,false".into())
    } else if rule == "hostname" || rule == "ip" {
        ("host", String::new())
    } else if rule.is_empty() {
        ("default", String::new())
    } else {
        ("none", String::new())
    }
}

// ---------------------------------------------------------------------------
// Cli
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Flag,
    Value,
    Array,
}

#[derive(Debug, Clone)]
struct Opt {
    var: String,
    long: String,
    short: String,
    kind: Kind,
    default: String,
    required: bool,
    description: String,
    group: String,
    rule: String,
    search_dirs: Vec<String>,
}

impl Opt {
    fn label(&self) -> String {
        let head =
            if self.short.is_empty() { format!("    --{}", self.long) } else { format!("-{}, --{}", self.short, self.long) };
        if self.kind == Kind::Flag {
            head
        } else {
            head + "=<value>"
        }
    }
    fn bool_like(&self) -> bool {
        self.kind == Kind::Flag || ["bool", "choice:true,false", "choice:false,true"].contains(&self.rule.as_str())
    }
}

#[derive(Debug, Clone)]
struct Arg {
    name: String,
    description: String,
    default: String,
    rule: String,
    variadic: bool,
}

#[derive(Debug, Clone)]
enum Raw {
    One(String),
    Many(Vec<String>),
}

/// Outcome of [`Cli::parse`].
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Ok,
    Help,
    Error { message: String, show_usage: bool, detail: Vec<String> },
}

impl Parsed {
    fn err(message: String) -> Parsed {
        Parsed::Error { message, show_usage: true, detail: Vec::new() }
    }
}

/// Handle returned by [`Cli::opt`] and friends for optional settings on the same line.
pub struct OptRef<'a> {
    cli: &'a mut Cli,
    index: usize,
}

impl<'a> OptRef<'a> {
    /// Help section (default "Options").
    pub fn group(self, group: &str) -> Self {
        self.cli.options[self.index].group = group.to_string();
        self
    }
    /// Validation rule (spec section 5). Panics on an unknown rule.
    pub fn rule(self, rule: &str) -> Self {
        let long = self.cli.options[self.index].long.clone();
        if !known_rule(rule) {
            panic!("Unknown validation rule '{rule}' for --{long}");
        }
        self.cli.options[self.index].rule = rule.to_string();
        self
    }
}

/// Handle returned by [`Cli::arg`] for an optional rule on the same line.
pub struct ArgRef<'a> {
    cli: &'a mut Cli,
    index: usize,
}

impl<'a> ArgRef<'a> {
    pub fn rule(self, rule: &str) -> Self {
        let name = self.cli.args[self.index].name.clone();
        if !known_rule(rule) {
            panic!("Unknown validation rule '{rule}' for {name}");
        }
        self.cli.args[self.index].rule = rule.to_string();
        self
    }
}

#[derive(Debug, Clone)]
pub struct Cli {
    name: String,
    root: String,
    cwd: String,
    env: HashMap<String, String>,
    description: String,
    epilog: String,
    options: Vec<Opt>,
    args: Vec<Arg>,
    commands: Vec<(String, String, String)>,
    config_option: String,
    config_prefixes: Vec<String>,
    raw: HashMap<String, Raw>,
    arg_raw: HashMap<String, Raw>,
    sources: HashMap<String, &'static str>,
    config: HashMap<String, (String, String)>,
    values: Values,
}

impl Default for Cli {
    fn default() -> Self {
        Self::new()
    }
}

impl Cli {
    /// A CLI named after argv[0], rooted at the current directory, reading the process environment.
    pub fn new() -> Cli {
        let name = std::env::args().next().map(|a| a.rsplit('/').next().unwrap_or("").to_string()).unwrap_or_default();
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "/".into());
        Cli {
            name,
            root: cwd.clone(),
            cwd,
            env: std::env::vars().collect(),
            description: String::new(),
            epilog: String::new(),
            options: Vec::new(),
            args: Vec::new(),
            commands: Vec::new(),
            config_option: String::new(),
            config_prefixes: Vec::new(),
            raw: HashMap::new(),
            arg_raw: HashMap::new(),
            sources: HashMap::new(),
            config: HashMap::new(),
            values: Values::default(),
        }
    }

    /// Program name shown in usage.
    pub fn name(&mut self, name: &str) -> &mut Self {
        self.name = name.into();
        self
    }
    /// Base directory for default/env path values and search dirs (relative to cwd).
    pub fn root(&mut self, root: &str) -> &mut Self {
        self.root = join_norm(&self.cwd, root);
        self
    }
    /// Directory command-line paths are relative to.
    pub fn cwd(&mut self, cwd: &str) -> &mut Self {
        self.cwd = cwd.into();
        self
    }
    /// Replace the environment options are read from.
    pub fn env<I: IntoIterator<Item = (String, String)>>(&mut self, env: I) -> &mut Self {
        self.env = env.into_iter().collect();
        self
    }
    pub fn description(&mut self, text: &str) -> &mut Self {
        self.description = text.into();
        self
    }
    pub fn epilog(&mut self, text: &str) -> &mut Self {
        self.epilog = text.into();
        self
    }

    /// `option` holds the config file path; `prefixes` is comma-separated.
    pub fn config(&mut self, option: &str, prefixes: &str) -> &mut Self {
        self.config_option = option.into();
        self.config_prefixes = prefixes.split(',').map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect();
        self
    }

    pub fn require_command(&mut self, command: &str, description: &str, install_hint: &str) -> &mut Self {
        self.commands.push((command.into(), description.into(), install_hint.into()));
        self
    }

    /// Fallback dirs (colon-separated, relative to root) for bare relative values of a path option.
    pub fn path_search(&mut self, long: &str, dirs: &str) -> &mut Self {
        let root = self.root.clone();
        let opt =
            self.options.iter_mut().find(|o| o.long == long).unwrap_or_else(|| panic!("path_search: unknown option --{long}"));
        opt.search_dirs = dirs.split(':').filter(|d| !d.is_empty()).map(|d| join_norm(&root, d)).collect();
        if opt.rule.is_empty() {
            opt.rule = "path".into();
        }
        self
    }

    /// Register an option. `default` is a value, "flag", "optional", or "" (required).
    pub fn opt(&mut self, var: &str, long: &str, short: &str, default: &str, description: &str) -> OptRef<'_> {
        let kind = if default == "flag" { Kind::Flag } else { Kind::Value };
        let dflt = if default == "flag" || default == "optional" { "" } else { default };
        self.add_opt(var, long, short, kind, dflt, default.is_empty(), description)
    }

    /// Register a repeatable option whose values accumulate into a list.
    pub fn opt_array(&mut self, var: &str, long: &str, short: &str, description: &str) -> OptRef<'_> {
        self.add_opt(var, long, short, Kind::Array, "", false, description)
    }

    /// Register a positional argument. An empty default makes it required.
    pub fn arg(&mut self, name: &str, description: &str, default: &str, rule: &str) -> ArgRef<'_> {
        self.add_arg(name, description, default, false).rule(rule)
    }

    /// Register a final positional argument that collects all remaining tokens.
    pub fn arg_variadic(&mut self, name: &str, description: &str, rule: &str) -> ArgRef<'_> {
        self.add_arg(name, description, "", true).rule(rule)
    }

    #[allow(clippy::too_many_arguments)]
    fn add_opt(
        &mut self,
        var: &str,
        long: &str,
        short: &str,
        kind: Kind,
        default: &str,
        required: bool,
        description: &str,
    ) -> OptRef<'_> {
        if self.options.iter().any(|o| o.long == long) {
            panic!("Duplicate option --{long}");
        }
        if !short.is_empty() && (short.chars().count() != 1 || self.options.iter().any(|o| o.short == short)) {
            panic!("Invalid or duplicate short option -{short}");
        }
        self.options.push(Opt {
            var: var.into(),
            long: long.into(),
            short: short.into(),
            kind,
            default: default.into(),
            required,
            description: description.into(),
            group: "Options".into(),
            rule: String::new(),
            search_dirs: Vec::new(),
        });
        let index = self.options.len() - 1;
        OptRef { cli: self, index }
    }

    fn add_arg(&mut self, name: &str, description: &str, default: &str, variadic: bool) -> ArgRef<'_> {
        if self.args.iter().any(|a| a.variadic) {
            panic!("Argument {name} registered after a variadic argument");
        }
        self.args.push(Arg {
            name: name.into(),
            description: description.into(),
            default: default.into(),
            rule: String::new(),
            variadic,
        });
        let index = self.args.len() - 1;
        ArgRef { cli: self, index }
    }

    fn ensure_help(&mut self) {
        if !self.options.iter().any(|o| o.long == "help") {
            let short = if self.options.iter().any(|o| o.short == "h") { "" } else { "h" };
            self.add_opt("HELP", "help", short, Kind::Flag, "", false, "Show this help message and exit").group("Global");
        }
    }

    fn find(&self, long: &str) -> Option<usize> {
        self.options.iter().position(|o| o.long == long)
    }

    // -- parsing --------------------------------------------------------------

    /// Parse without exiting. Values are available via [`Cli::values`] when the result is `Parsed::Ok`.
    pub fn parse<S: AsRef<str>>(&mut self, argv: &[S]) -> Parsed {
        let argv: Vec<String> = argv.iter().map(|s| s.as_ref().to_string()).collect();
        self.raw.clear();
        self.arg_raw.clear();
        self.sources.clear();
        self.config.clear();
        self.values = Values::default();
        self.ensure_help();

        let mut result = self.scan(&argv);
        if result.is_ok() && !self.config_option.is_empty() {
            result = self.load_config();
        }
        if matches!(self.raw.get("help"), Some(Raw::One(v)) if v == "true") {
            return Parsed::Help;
        }
        if let Err(e) = result.and_then(|_| self.resolve()) {
            return Parsed::err(e);
        }

        let path_var = self.env.get("PATH").cloned().unwrap_or_default();
        let missing: Vec<&(String, String, String)> =
            self.commands.iter().filter(|c| !command_available(&c.0, &path_var)).collect();
        if !missing.is_empty() {
            let mut detail = Vec::new();
            for (cmd, desc, hint) in &missing {
                detail.push(format!("  {cmd} - {desc}"));
                if !hint.is_empty() {
                    detail.push(format!("    Install: {hint}"));
                }
            }
            let names: Vec<&str> = missing.iter().map(|c| c.0.as_str()).collect();
            return Parsed::Error {
                message: format!("Missing required command(s): {}", names.join(", ")),
                show_usage: false,
                detail,
            };
        }

        let missing: Vec<String> = self
            .options
            .iter()
            .filter(|o| o.required && !matches!(self.raw.get(&o.long), Some(Raw::One(v)) if !v.is_empty()))
            .map(|o| format!("--{}", o.long))
            .collect();
        if !missing.is_empty() {
            return Parsed::err(format!("Missing required argument(s): {}", missing.join(" ")));
        }
        Parsed::Ok
    }

    fn set_cli(&mut self, i: usize, value: String) {
        let opt = &self.options[i];
        let long = opt.long.clone();
        if opt.kind == Kind::Array {
            let mut list = match (self.sources.get(&long), self.raw.remove(&long)) {
                (Some(&"cli"), Some(Raw::Many(l))) => l,
                _ => Vec::new(),
            };
            list.push(value);
            self.raw.insert(long.clone(), Raw::Many(list));
        } else {
            self.raw.insert(long.clone(), Raw::One(value));
        }
        self.sources.insert(long, "cli");
    }

    fn scan(&mut self, argv: &[String]) -> Result<(), String> {
        let mut pos = 0;
        let mut rest: Option<Vec<String>> = None;
        let mut variadic_name = String::new();
        let mut end_of_options = false;
        let mut i = 0;
        let result = (|| {
            while i < argv.len() {
                let token = argv[i].clone();
                i += 1;
                if end_of_options || token == "-" || !token.starts_with('-') {
                    if let Some(r) = rest.as_mut() {
                        r.push(token);
                    } else if pos >= self.args.len() {
                        return Err(format!("Unexpected argument: {token}"));
                    } else {
                        let arg = &self.args[pos];
                        pos += 1;
                        if arg.variadic {
                            variadic_name = arg.name.clone();
                            rest = Some(vec![token]);
                        } else {
                            self.arg_raw.insert(arg.name.clone(), Raw::One(token));
                        }
                    }
                } else if token == "--" {
                    end_of_options = true;
                } else if let Some(body) = token.strip_prefix("--") {
                    let (name, value) = match body.split_once('=') {
                        Some((n, v)) => (n.to_string(), Some(v.to_string())),
                        None => (body.to_string(), None),
                    };
                    if let Some(idx) = self.find(&name) {
                        let kind = self.options[idx].kind;
                        match value {
                            Some(v) if kind == Kind::Flag => match bool_word(&v) {
                                Some(b) => self.set_cli(idx, b.to_string()),
                                None => return Err(format!("Option --{name} expects a boolean value, got '{v}'")),
                            },
                            Some(v) => self.set_cli(idx, v),
                            None if kind == Kind::Flag => self.set_cli(idx, "true".into()),
                            None => match argv.get(i) {
                                Some(next) if !next.starts_with("--") => {
                                    let next = next.clone();
                                    self.set_cli(idx, next);
                                    i += 1;
                                }
                                _ => return Err(format!("Option --{name} requires an argument")),
                            },
                        }
                    } else if let (Some(target), None) = (name.strip_prefix("no-").and_then(|n| self.find(n)), &value) {
                        if !self.options[target].bool_like() {
                            return Err(format!("Option --{name} can only be used with flag/boolean options"));
                        }
                        self.set_cli(target, "false".into());
                    } else {
                        return Err(format!("Unknown option: --{name}"));
                    }
                } else {
                    let cluster: Vec<char> = token[1..].chars().collect();
                    for (j, ch) in cluster.iter().enumerate() {
                        let idx = self
                            .options
                            .iter()
                            .position(|o| o.short == ch.to_string())
                            .ok_or(format!("Unknown option: -{ch}"))?;
                        if self.options[idx].kind == Kind::Flag {
                            self.set_cli(idx, "true".into());
                            continue;
                        }
                        if j + 1 < cluster.len() {
                            self.set_cli(idx, cluster[j + 1..].iter().collect());
                            break;
                        }
                        match argv.get(i) {
                            Some(next) if !next.starts_with('-') => {
                                let next = next.clone();
                                self.set_cli(idx, next);
                                i += 1;
                            }
                            _ => return Err(format!("Option -{ch} requires an argument")),
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Some(r) = rest {
            self.arg_raw.insert(variadic_name, Raw::Many(r));
        }
        result
    }

    fn load_config(&mut self) -> Result<(), String> {
        let Some(idx) = self.find(&self.config_option.clone()) else { return Ok(()) };
        let opt = self.options[idx].clone();
        let (path, source) = match self.raw.get(&opt.long) {
            Some(Raw::One(v)) => (v.clone(), "cli"),
            _ => match self.env.get(&opt.var).filter(|v| !v.is_empty()) {
                Some(v) => (v.clone(), "env"),
                None => (opt.default.clone(), "default"),
            },
        };
        if path.is_empty() || path == "disabled" {
            return Ok(());
        }
        let resolved = resolve_path(&path, &self.cwd, &opt.search_dirs);
        self.raw.insert(opt.long.clone(), Raw::One(resolved.clone()));
        self.sources.insert(opt.long.clone(), source);
        self.read_config(&resolved, 0, &mut HashSet::new())?;

        let entries: Vec<(String, String)> = self.config.iter().map(|(k, (v, _))| (k.clone(), v.clone())).collect();
        for (key, value) in entries {
            let Some(t) = self.find(&key) else { continue };
            if t == idx || self.sources.get(&key) == Some(&"cli") {
                continue;
            }
            let raw = match self.options[t].kind {
                Kind::Flag => match bool_word(&value) {
                    Some(b) => Raw::One(b.to_string()),
                    None => return Err(format!("Config value for --{key} must be a boolean, got '{value}'")),
                },
                Kind::Array => Raw::Many(vec![value]),
                Kind::Value => Raw::One(value),
            };
            self.raw.insert(key.clone(), raw);
            self.sources.insert(key, "config");
        }
        Ok(())
    }

    fn read_config(&mut self, path: &str, depth: usize, stack: &mut HashSet<String>) -> Result<(), String> {
        if depth > 10 {
            return Err(format!("Config include depth exceeded (10) while processing: {path}"));
        }
        if !Path::new(path).is_file() {
            return Err(format!("Config file not found: {path}"));
        }
        if !stack.insert(path.to_string()) {
            return Err(format!("Circular config include detected: {path}"));
        }
        let dir = dirname(path);
        let text = std::fs::read_to_string(path).map_err(|_| format!("Config file not found: {path}"))?;
        let include = re(r"^\s*@include\s+(.+)$");
        for line in text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(cap) = include.captures(line) {
                let mut target = cap[1].trim();
                for q in ['"', '\''] {
                    if target.len() >= 2 && target.starts_with(q) && target.ends_with(q) {
                        target = &target[1..target.len() - 1];
                    }
                }
                self.read_config(&join_norm(&dir, target), depth + 1, stack)?;
                continue;
            }
            let body = if self.config_prefixes.is_empty() {
                line
            } else {
                match self.config_prefixes.iter().find(|p| line.starts_with(p.as_str())) {
                    Some(p) => &line[p.len()..],
                    None => continue,
                }
            };
            let Some((key, value)) = body.split_once('=') else { continue };
            let key = key.trim();
            let key = key.strip_prefix("--").unwrap_or(key);
            if !key.is_empty() {
                self.config.insert(key.to_string(), (value.trim().to_string(), dir.clone()));
            }
        }
        stack.remove(path);
        Ok(())
    }

    fn resolve(&mut self) -> Result<(), String> {
        for arg in &self.args {
            if self.arg_raw.contains_key(&arg.name) {
                continue;
            }
            if arg.variadic {
                self.arg_raw.insert(arg.name.clone(), Raw::Many(Vec::new()));
            } else if arg.default.is_empty() {
                return Err(format!("Missing required positional argument: {}", arg.name));
            } else {
                self.arg_raw.insert(arg.name.clone(), Raw::One(arg.default.clone()));
            }
        }

        for opt in &self.options {
            if self.sources.contains_key(&opt.long) {
                continue;
            }
            let env_value = if opt.kind == Kind::Array { None } else { self.env.get(&opt.var).filter(|v| !v.is_empty()) };
            if let Some(v) = env_value {
                let v = if opt.kind == Kind::Flag {
                    bool_word(v).ok_or(format!("Environment variable {} must be a boolean, got '{v}'", opt.var))?.to_string()
                } else {
                    v.clone()
                };
                self.raw.insert(opt.long.clone(), Raw::One(v));
                self.sources.insert(opt.long.clone(), "env");
            } else if opt.kind == Kind::Flag {
                self.raw.insert(opt.long.clone(), Raw::One("false".into()));
                self.sources.insert(opt.long.clone(), "default");
            } else if !opt.default.is_empty() {
                self.raw.insert(opt.long.clone(), Raw::One(opt.default.clone()));
                self.sources.insert(opt.long.clone(), "default");
            }
        }

        // Path resolution: the base depends on where the value came from.
        for opt in &self.options {
            if !is_path_rule(&opt.rule) || opt.long == self.config_option {
                continue;
            }
            let Some(raw) = self.raw.get_mut(&opt.long) else { continue };
            let base = match self.sources.get(&opt.long) {
                Some(&"cli") => self.cwd.clone(),
                Some(&"config") => self.config[&opt.long].1.clone(),
                _ => self.root.clone(),
            };
            match raw {
                Raw::One(v) => *v = resolve_path(v, &base, &opt.search_dirs),
                Raw::Many(l) => l.iter_mut().for_each(|v| *v = resolve_path(v, &base, &opt.search_dirs)),
            }
        }
        for arg in &self.args {
            if !is_path_rule(&arg.rule) {
                continue;
            }
            match self.arg_raw.get_mut(&arg.name) {
                Some(Raw::One(v)) => *v = resolve_path(v, &self.cwd, &[]),
                Some(Raw::Many(l)) => l.iter_mut().for_each(|v| *v = resolve_path(v, &self.cwd, &[])),
                None => {}
            }
        }

        let convert = |v: &str, rule: &str, name: &str| -> Result<Value, String> {
            if v.is_empty() || rule.is_empty() {
                Ok(Value::Str(v.into()))
            } else {
                validate(v, rule, name)
            }
        };
        let convert_raw = |raw: &Raw, rule: &str, name: &str| -> Result<Value, String> {
            match raw {
                Raw::One(v) => convert(v, rule, name),
                Raw::Many(l) => Ok(Value::List(l.iter().map(|v| convert(v, rule, name)).collect::<Result<_, _>>()?)),
            }
        };
        let mut values = Values::default();
        for opt in &self.options {
            let value = match (self.raw.get(&opt.long), opt.kind) {
                (None, Kind::Array) => Value::List(Vec::new()),
                (None, _) => Value::Null,
                (Some(Raw::One(v)), Kind::Flag) => Value::Bool(v == "true"),
                (Some(raw), _) => convert_raw(raw, &opt.rule, &format!("--{}", opt.long))?,
            };
            values.set(&opt.var, value);
        }
        for arg in &self.args {
            values.set(&arg.name, convert_raw(&self.arg_raw[&arg.name], &arg.rule, &arg.name)?);
        }
        self.values = values;
        Ok(())
    }

    /// Parse `std::env::args()` like a CLI: handles --help, --help-json-schema and
    /// --bash-completion, prints errors and exits on failure. Returns the values.
    pub fn run(&mut self) -> Values {
        let argv: Vec<String> = std::env::args().skip(1).collect();
        self.run_with(&argv)
    }

    /// [`Cli::run`] with explicit arguments (excluding the program name).
    pub fn run_with<S: AsRef<str>>(&mut self, argv: &[S]) -> Values {
        let head = argv.iter().map(AsRef::as_ref).take_while(|a| *a != "--");
        for a in head {
            if a == "--help-json-schema" {
                println!("{}", self.json_schema());
                std::process::exit(0);
            }
            if a == "--bash-completion" {
                print!("{}", self.completion_data());
                std::process::exit(0);
            }
        }
        match self.parse(argv) {
            Parsed::Ok => self.values.clone(),
            Parsed::Help => {
                print!("{}", self.usage());
                std::process::exit(0)
            }
            Parsed::Error { message, show_usage, detail } => {
                emit("error", &message, true);
                for line in detail {
                    eprintln!("{line}");
                }
                if show_usage {
                    eprint!("{}", self.usage());
                }
                std::process::exit(1)
            }
        }
    }

    // -- accessors ------------------------------------------------------------

    pub fn values(&self) -> &Values {
        &self.values
    }

    /// Where an option's value came from: cli, config, env, default or unset.
    pub fn source(&self, long: &str) -> &'static str {
        self.sources.get(long.strip_prefix("--").unwrap_or(long)).copied().unwrap_or("unset")
    }

    pub fn is_set(&self, long: &str) -> bool {
        self.source(long) == "cli"
    }

    pub fn is_explicitly_set(&self, long: &str) -> bool {
        matches!(self.source(long), "cli" | "config" | "env")
    }

    /// Resolved values as JSON (spec section 10).
    pub fn values_json(&self) -> String {
        Json::Map(self.values.iter().map(|(k, v)| (k.to_string(), Json::from_value(v))).collect()).pretty()
    }

    // -- output ---------------------------------------------------------------

    /// Help text (spec section 7).
    pub fn usage(&mut self) -> String {
        self.ensure_help();
        let max_width = self.env.get("CLYOPS_MAX_WIDTH").and_then(|w| w.parse::<usize>().ok()).filter(|w| *w > 0).unwrap_or(100);
        let longest = self.options.iter().map(|o| o.label().chars().count()).max().unwrap_or(0);
        let indent = (longest + 4).clamp(32, 50);
        let text_width = max_width.saturating_sub(indent).max(20);

        let row = |label: &str, text: &str| -> Vec<String> {
            let mut left = format!("  {label}");
            let len = left.chars().count();
            if len < indent {
                left.push_str(&" ".repeat(indent - len))
            } else {
                left.push(' ')
            }
            let lines = wrap_text(text, text_width);
            let mut out = vec![format!("{left}{}", lines[0])];
            out.extend(lines[1..].iter().map(|l| format!("{}{l}", " ".repeat(indent))));
            out
        };
        let annotate = |text: &str, notes: &[String]| {
            if notes.is_empty() {
                text.to_string()
            } else {
                format!("{text} ({})", notes.join(", "))
            }
        };

        let mut sections: Vec<Vec<String>> = Vec::new();
        let mut usage = format!("Usage: {}", self.name);
        for a in &self.args {
            usage += &if a.variadic {
                format!(" [<{}...>]", a.name)
            } else if a.default.is_empty() {
                format!(" <{}>", a.name)
            } else {
                format!(" [<{}>]", a.name)
            };
        }
        sections.push(vec![usage + " [OPTIONS]"]);

        if !self.description.is_empty() {
            sections.push(wrap_text(&self.description, max_width));
        }

        if !self.args.is_empty() {
            let mut lines = vec!["Positional Arguments:".to_string()];
            for a in &self.args {
                let mut notes = Vec::new();
                if a.variadic {
                    notes.push("variadic".to_string())
                }
                if !a.default.is_empty() {
                    notes.push(format!("default: {}", a.default))
                }
                if !a.rule.is_empty() {
                    notes.push(format!("accepts: {}", describe_rule(&a.rule)))
                }
                lines.extend(row(&a.name, &annotate(&a.description, &notes)));
            }
            sections.push(lines);
        }

        if !self.commands.is_empty() {
            let path_var = self.env.get("PATH").cloned().unwrap_or_default();
            let mut lines = vec!["Required Commands:".to_string()];
            for (cmd, desc, hint) in &self.commands {
                let status = if command_available(cmd, &path_var) { "installed" } else { "not found" };
                let text = if hint.is_empty() { desc.clone() } else { format!("{desc} ({hint})") };
                lines.extend(row(&format!("{cmd} [{status}]"), &text));
            }
            sections.push(lines);
        }

        let mut groups: Vec<&str> = Vec::new();
        for o in &self.options {
            if !groups.contains(&o.group.as_str()) {
                groups.push(&o.group);
            }
        }
        for group in groups {
            let mut lines = vec![format!("{group}:")];
            for o in self.options.iter().filter(|o| o.group == group) {
                let mut notes = Vec::new();
                if o.required {
                    notes.push("required".to_string())
                }
                if o.kind == Kind::Array {
                    notes.push("multiple".to_string())
                }
                if let Some((v, _)) = self.config.get(&o.long) {
                    notes.push(format!("config: {v}"))
                }
                if !o.default.is_empty() {
                    notes.push(format!("default: {}", o.default))
                }
                if !o.rule.is_empty() {
                    notes.push(format!("accepts: {}", describe_rule(&o.rule)))
                }
                lines.extend(row(&o.label(), &annotate(&o.description, &notes)));
            }
            sections.push(lines);
        }

        if !self.epilog.is_empty() {
            sections.push(self.epilog.trim_end_matches('\n').split('\n').map(String::from).collect());
        }

        let text = sections.iter().map(|s| s.join("\n")).collect::<Vec<_>>().join("\n\n");
        text.split('\n').map(str::trim_end).collect::<Vec<_>>().join("\n") + "\n"
    }

    /// JSON description of the CLI (spec section 8).
    pub fn json_schema(&mut self) -> String {
        self.ensure_help();
        let type_of = |o: &Opt| {
            let r = o.rule.as_str();
            if o.kind == Kind::Flag || r == "bool" {
                "boolean"
            } else if r.starts_with("int") || r == "port" {
                "integer"
            } else if r.starts_with("float") {
                "number"
            } else if r.starts_with("choice:") {
                "choice"
            } else if is_path_rule(r) {
                "path"
            } else {
                "string"
            }
        };
        let s = |v: &str| Json::Str(v.to_string());
        Json::Obj(vec![
            ("clyops", Json::Num("1".into())),
            ("script", s(&self.name)),
            ("description", s(&self.description)),
            ("epilog", s(&self.epilog)),
            (
                "arguments",
                Json::Arr(
                    self.args
                        .iter()
                        .map(|a| {
                            Json::Obj(vec![
                                ("name", s(&a.name)),
                                ("description", s(&a.description)),
                                ("required", Json::Bool(!a.variadic && a.default.is_empty())),
                                ("isVariadic", Json::Bool(a.variadic)),
                                ("default", s(&a.default)),
                                ("validation", s(&a.rule)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "options",
                Json::Arr(
                    self.options
                        .iter()
                        .map(|o| {
                            Json::Obj(vec![
                                ("name", s(&o.long)),
                                ("shortName", s(&o.short)),
                                ("variableName", s(&o.var)),
                                ("description", s(&o.description)),
                                ("default", s(if o.kind == Kind::Flag { "false" } else { &o.default })),
                                ("group", s(&o.group)),
                                ("type", s(type_of(o))),
                                ("isFlag", Json::Bool(o.kind == Kind::Flag)),
                                ("isArray", Json::Bool(o.kind == Kind::Array)),
                                ("required", Json::Bool(o.required)),
                                ("validation", s(&o.rule)),
                                (
                                    "choices",
                                    Json::Arr(
                                        o.rule.strip_prefix("choice:").map(|c| c.split(',').map(s).collect()).unwrap_or_default(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "requiredCommands",
                Json::Arr(
                    self.commands
                        .iter()
                        .map(|(c, d, h)| Json::Obj(vec![("command", s(c)), ("description", s(d)), ("installHint", s(h))]))
                        .collect(),
                ),
            ),
        ])
        .pretty()
    }

    /// Tab-separated completion records (spec section 9).
    pub fn completion_data(&mut self) -> String {
        self.ensure_help();
        let clean = |s: &str| s.replace(['\t', '\n'], " ");
        let mut out = String::from("#clyops-completion 1\n");
        for o in &self.options {
            let short = if o.short.is_empty() { "-".to_string() } else { format!("-{}", o.short) };
            if o.kind == Kind::Flag {
                let _ = writeln!(out, "opt\t--{}\t{short}\tflag\tnone\t-\t{}", o.long, clean(&o.description));
            } else {
                let (kind, values) = completion_kind(&o.rule, &o.search_dirs);
                let values = if values.is_empty() { "-".to_string() } else { values };
                let _ = writeln!(out, "opt\t--{}\t{short}\tvalue\t{kind}\t{values}\t{}", o.long, clean(&o.description));
            }
            if o.bool_like() {
                let _ = writeln!(out, "opt\t--no-{}\t-\tflag\tnone\t-\t{}", o.long, clean(&o.description));
            }
        }
        for a in &self.args {
            let (kind, values) = completion_kind(&a.rule, &[]);
            let values = if values.is_empty() { "-".to_string() } else { values };
            let arity = if a.variadic { "variadic" } else { "single" };
            let _ = writeln!(out, "arg\t{}\t{arity}\t{kind}\t{values}\t{}", a.name, clean(&a.description));
        }
        out
    }
}
