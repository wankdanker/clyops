// Conservative source inspection; keep in sync with clyops-tools detection.ts.
struct Token {
    value: String,
    literal: bool,
    line: usize,
    first: bool,
    start: usize,
    end: usize,
}

pub fn uses_clyops(source: &[u8]) -> bool {
    if !source.starts_with(b"#!") && source.contains(&0) {
        return source.windows(18).any(|s| s == b"#clyops-completion");
    }
    let mut tokens: Vec<Token> = Vec::new();
    let mut line = 1;
    let mut first = true;
    let mut i = 0;
    let mut heredoc: Option<String> = None;
    while i < source.len() {
        let c = source[i];
        if c == b'\n' {
            i += 1;
            line += 1;
            first = true;
            if let Some(delimiter) = heredoc.take() {
                while i < source.len() {
                    let end = source[i..].iter().position(|b| *b == b'\n').map(|n| i + n).unwrap_or(source.len());
                    let done = String::from_utf8_lossy(&source[i..end]).trim() == delimiter;
                    i = (end + 1).min(source.len());
                    line += 1;
                    if done {
                        break;
                    }
                }
            }
            continue;
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == b'#' || source[i..].starts_with(b"//") {
            let end = source[i..].iter().position(|b| *b == b'\n').map(|n| i + n).unwrap_or(source.len());
            let comment = String::from_utf8_lossy(&source[i..end]);
            let body = comment.strip_prefix('#').or_else(|| comment.strip_prefix("//")).unwrap_or("");
            if first && line <= 10 && body.trim() == "clyops-tool" {
                return true;
            }
            i = end;
            continue;
        }
        if source[i..].starts_with(b"/*") {
            let end = source[i + 2..].windows(2).position(|s| s == b"*/").map(|n| i + n + 4).unwrap_or(source.len());
            line += source[i..end].iter().filter(|b| **b == b'\n').count();
            i = end;
            first = false;
            continue;
        }
        let start = i;
        let token_line = line;
        let token_first = first;
        let literal;
        let value;
        if b"'\"`".contains(&c) {
            let quote = if source[i..].starts_with(&[c, c, c]) { 3 } else { 1 };
            i += quote;
            let content = i;
            while i < source.len() && !source[i..].starts_with(&vec![c; quote]) {
                if source[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = i.min(source.len());
            value =
                if quote == 3 || c == b'`' { String::new() } else { String::from_utf8_lossy(&source[content..i]).into_owned() };
            literal = true;
            i = (i + quote).min(source.len());
            line += source[start..i].iter().filter(|b| **b == b'\n').count();
        } else if c.is_ascii_alphanumeric() || b"_$-".contains(&c) {
            while i < source.len() && (source[i].is_ascii_alphanumeric() || b"_$-".contains(&source[i])) {
                i += 1;
            }
            value = String::from_utf8_lossy(&source[start..i]).into_owned();
            literal = false;
        } else {
            value = char::from(c).to_string();
            i += 1;
            literal = false;
        }
        tokens.push(Token { value: value.clone(), literal, line: token_line, first: token_first, start, end: i });
        first = false;
        let n = tokens.len();
        if n >= 3 && tokens[n - 3].value == "<" && tokens[n - 2].value == "<" {
            heredoc = Some(value.clone());
        }
        if n >= 4 && tokens[n - 4].value == "<" && tokens[n - 3].value == "<" && tokens[n - 2].value == "-" {
            heredoc = Some(value);
        }
    }
    let module = |t: Option<&Token>| {
        t.is_some_and(|t| {
            t.literal
                && !t.value.contains('\n')
                && (t.value == "clyops"
                    || t.value.starts_with("clyops-")
                    || t.value.starts_with("clyops/")
                    || ["/clyops.cjs", "/clyops.mjs", "/clyops.js", "/clyops.ts"].iter().any(|suffix| t.value.ends_with(suffix)))
        })
    };
    for (n, t) in tokens.iter().enumerate() {
        if t.literal {
            continue;
        }
        let next = tokens.get(n + 1);
        if t.first && (t.value == "source" || t.value == ".") {
            if let Some(next) = next.filter(|next| next.line == t.line) {
                let mut path = next.value.clone();
                let mut end = next.end;
                for part in tokens.iter().skip(n + 2) {
                    if part.start != end {
                        break;
                    }
                    path.push_str(&part.value);
                    end = part.end;
                }
                if path == "clyops.sh" || path.ends_with("/clyops.sh") {
                    return true;
                }
            }
        }
        if t.first
            && (t.value == "import" || t.value == "from")
            && next.is_some_and(|next| next.value == "clyops" && !next.literal)
        {
            return true;
        }
        if t.value == "require"
            && (n == 0 || tokens[n - 1].value != ".")
            && next.is_some_and(|t| t.value == "(")
            && module(tokens.get(n + 2))
            && tokens.get(n + 3).is_some_and(|t| t.value == ")")
        {
            return true;
        }
        if t.first && t.value == "import" {
            if module(next) {
                return true;
            }
            for j in n + 1..tokens.len() {
                let part = &tokens[j];
                if part.value == ";" {
                    break;
                }
                if !part.literal && part.value == "from" && module(tokens.get(j + 1)) {
                    return true;
                }
                if part.first && ["import", "const", "let", "var", "function"].contains(&part.value.as_str()) {
                    break;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_detection_cases() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../../spec/conformance/detection.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                uses_clyops(case["source"].as_str().unwrap().as_bytes()),
                case["tool"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
