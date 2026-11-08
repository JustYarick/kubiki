//! Local transcript storage. Provider replay, credentials, approvals and raw tools are excluded.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, sync::Mutex};
use tauri::Manager;
static GATE: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub enabled: bool,
    pub retention_days: u32,
    pub allow_export: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            retention_days: 30,
            allow_export: true,
        }
    }
}
fn err(_: impl std::fmt::Display) -> String {
    "Local AI history operation failed".into()
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    // Restrictive initial permissions also cover SQLite's connection/journal defaults.
    let mut file = std::fs::OpenOptions::new();
    file.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    file.open(path).map_err(err)?;
    let db = Connection::open(path).map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    if version > 1 {
        return Err("AI history was created by a newer application version".into());
    }
    db.execute_batch("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, updated INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deleted(id TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(id UNINDEXED, title, body, tokenize='unicode61'); INSERT INTO transcript_search(transcript_search,rank) VALUES('secure-delete',1); PRAGMA user_version=1;").map_err(err)?;
    Ok(db)
}
fn preferences(db: &Connection) -> Result<Preferences, String> {
    db.query_row(
        "SELECT value FROM settings WHERE key='preferences'",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(err)?
    .map(|s| serde_json::from_str(&s).map_err(err))
    .unwrap_or_else(|| Ok(Preferences::default()))
}
fn sanitize(value: &Value) -> Result<Value, String> {
    let id = value["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or("Invalid history identity")?;
    let title = value["title"]
        .as_str()
        .filter(|s| s.len() <= 500)
        .ok_or("Invalid history title")?;
    let scope: kubiki_ai::AgentScope =
        serde_json::from_value(value["scope"].clone()).map_err(|_| "Invalid history scope")?;
    if scope.context.len() > 253
        || scope.namespaces.len() > 200
        || scope.namespaces.iter().any(|s| s.len() > 253)
    {
        return Err("Invalid history scope".into());
    }
    let source = value["messages"]
        .as_array()
        .filter(|v| v.len() <= 2000)
        .ok_or("History conversation exceeds message limit")?;
    let mut messages = Vec::new();
    for message in source {
        let role = message["role"]
            .as_str()
            .filter(|s| ["user", "assistant", "tool"].contains(s))
            .ok_or("Invalid history message role")?;
        let text = message["text"]
            .as_str()
            .filter(|s| s.len() <= 256 * 1024)
            .ok_or("History message exceeds size limit")?;
        let id = message["id"]
            .as_str()
            .filter(|s| s.len() <= 128)
            .ok_or("Invalid history message ID")?;
        let mut safe = json!({"id":id,"role":role,"text":text});
        if role == "tool" {
            let mut args = json!({});
            for key in ["group", "version", "kind", "namespace", "name"] {
                if let Some(v) = message
                    .pointer(&format!("/call/arguments/{key}"))
                    .filter(|v| v.is_string() || v.is_null())
                {
                    args[key] = v.clone();
                }
            }
            safe["text"] = message["call"]["name"]
                .as_str()
                .filter(|s| s.len() <= 128)
                .unwrap_or("Tool")
                .into();
            safe["call"] = json!({"id":message["call"]["id"],"name":safe["text"],"arguments":args});
            safe["result"] = json!({"historical":true,"payloadOmitted":true});
            if let Some(op) = message["result"]["operationId"]
                .as_str()
                .filter(|s| s.len() <= 512)
            {
                safe["result"]["operationId"] = op.into();
                if let Some(status) = message["result"]["status"].as_str().filter(|s| {
                    [
                        "accepted",
                        "failed",
                        "cancelled",
                        "uncertain",
                        "dispatching",
                    ]
                    .contains(s)
                }) {
                    safe["result"]["status"] = status.into();
                }
            }
        }
        messages.push(safe);
    }
    let mut result = json!({"id":id,"title":title,"scope":scope,"messages":messages,"mode":"ask","phase":"plan","busy":false,"status":"idle","draft":"","inputTokens":0,"outputTokens":0});
    // Usage is display-only metadata, never replay or authorization state.
    // Keep provider totals across restarts instead of silently resetting them.
    for key in [
        "inputTokens",
        "outputTokens",
        "currentContextTokens",
        "contextBudgetTokens",
    ] {
        if let Some(count) = value[key].as_u64().filter(|n| *n <= 9_007_199_254_740_991) {
            result[key] = json!(count);
        }
    }
    if let Some(estimated) = value["contextEstimated"].as_bool() {
        result["contextEstimated"] = json!(estimated);
    }
    if let Some(entries) = value["generationMetrics"].as_array() {
        let mut metrics = Vec::new();
        for entry in entries.iter().rev().take(100).rev() {
            let mut row = json!({});
            for key in ["id", "model", "phase", "resolvedModel"] {
                if let Some(text) = entry[key].as_str().filter(|v| v.len() <= 512) {
                    row[key] = json!(text);
                }
            }
            for key in [
                "systemTokens",
                "toolTokens",
                "historyTokens",
                "inputTokens",
                "outputTokens",
                "durationMs",
                "toolCount",
                "cachedInputTokens",
                "reasoningOutputTokens",
                "firstTokenMs",
            ] {
                row[key] = entry[key]
                    .as_u64()
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .map_or(Value::Null, |n| json!(n));
            }
            if row["id"].is_string() {
                metrics.push(row);
            }
        }
        result["generationMetrics"] = json!(metrics);
    }
    result["intent"] = json!(
        value["intent"]
            .as_str()
            .filter(|s| ["chat", "investigate", "create"].contains(s))
            .unwrap_or("chat")
    );
    for key in ["providerId", "model"] {
        result[key] = json!(
            value[key]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(512)
                .collect::<String>()
        );
    }
    for key in ["pinned", "archived"] {
        result[key] = json!(value[key].as_bool().unwrap_or(false));
    }
    for key in ["createdAt", "updatedAt"] {
        result[key] = json!(
            value[key]
                .as_i64()
                .filter(|t| *t >= 0 && *t <= now() + 60_000)
                .unwrap_or_else(now)
        );
    }
    if result.to_string().len() > 2 * 1024 * 1024 {
        return Err("History conversation exceeds 2 MiB".into());
    }
    Ok(result)
}
fn purge(db: &Connection, prefs: &Preferences) -> Result<(), String> {
    if !prefs.enabled {
        db.execute("DELETE FROM conversations", []).map_err(err)?;
    }
    let cutoff = now() - i64::from(prefs.retention_days) * 86_400_000;
    db.execute("DELETE FROM conversations WHERE updated < ?1", [cutoff])
        .map_err(err)?;
    db.execute(
        "DELETE FROM transcript_search WHERE id NOT IN (SELECT id FROM conversations)",
        [],
    )
    .map_err(err)?;
    db.execute("DELETE FROM deleted WHERE at < ?1", [cutoff])
        .map_err(err)?;
    // Bound retained transcript count and bytes, independent of renderer behavior.
    loop {
        let (count, bytes): (i64, i64) = db
            .query_row(
                "SELECT count(*),coalesce(sum(length(CAST(payload AS BLOB))),0) FROM conversations",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(err)?;
        if count <= 200 && bytes <= 32 * 1024 * 1024 {
            break;
        }
        db.execute("DELETE FROM conversations WHERE id=(SELECT id FROM conversations ORDER BY updated ASC,id ASC LIMIT 1)",[]).map_err(err)?;
    }
    db.execute(
        "DELETE FROM transcript_search WHERE id NOT IN (SELECT id FROM conversations)",
        [],
    )
    .map_err(err)?;
    Ok(())
}
fn sync(
    db: &mut Connection,
    documents: Vec<Value>,
    deleted: Vec<String>,
    migration: bool,
) -> Result<(), String> {
    if documents.len() > 200 || deleted.len() > 200 {
        return Err("History batch exceeds limits".into());
    }
    let prefs = preferences(db)?;
    let docs = documents
        .iter()
        .map(sanitize)
        .collect::<Result<Vec<_>, _>>()?;
    let tx = db.transaction().map_err(err)?;
    for id in deleted {
        if id.len() > 128 {
            return Err("Invalid history ID".into());
        }
        tx.execute(
            "INSERT OR REPLACE INTO deleted VALUES(?1,?2)",
            params![id, now()],
        )
        .map_err(err)?;
        tx.execute("DELETE FROM conversations WHERE id=?1", [&id])
            .map_err(err)?;
        tx.execute("DELETE FROM transcript_search WHERE id=?1", [&id])
            .map_err(err)?;
    }
    if prefs.enabled {
        for doc in docs {
            let id = doc["id"].as_str().unwrap();
            let updated = doc["updatedAt"].as_i64().unwrap();
            let changed=tx.execute("INSERT INTO conversations(id,updated,payload) SELECT ?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM deleted WHERE id=?1) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,payload=excluded.payload WHERE excluded.updated>=conversations.updated",params![id,updated,doc.to_string()]).map_err(err)?;
            if changed > 0 {
                tx.execute("DELETE FROM transcript_search WHERE id=?1", [id])
                    .map_err(err)?;
                let body = doc["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] != "tool")
                    .filter_map(|m| m["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                tx.execute(
                    "INSERT INTO transcript_search(id,title,body) VALUES(?1,?2,?3)",
                    params![id, doc["title"].as_str().unwrap(), body],
                )
                .map_err(err)?;
            }
        }
    }
    if migration {
        tx.execute(
            "INSERT OR REPLACE INTO settings VALUES('migration','1')",
            [],
        )
        .map_err(err)?;
    }
    purge(&tx, &prefs)?;
    tx.commit().map_err(err)
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Search {
    text: String,
    context: Option<String>,
    namespace: Option<String>,
    after: Option<i64>,
    before: Option<i64>,
    include_archived: bool,
}
fn load(db: &Connection, filter: Search) -> Result<Value, String> {
    if filter.text.len() > 1024 {
        return Err("History search is too long".into());
    }
    let prefs = preferences(db)?;
    {
        let tx = db.unchecked_transaction().map_err(err)?;
        purge(&tx, &prefs)?;
        tx.commit().map_err(err)?;
    }
    let mut stmt = db
        .prepare("SELECT payload FROM conversations ORDER BY updated DESC,id ASC LIMIT 200")
        .map_err(err)?;
    let docs = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let matched = if filter.text.trim().is_empty() {
        None
    } else {
        let expression = filter
            .text
            .split_whitespace()
            .take(16)
            .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let mut stmt = db
            .prepare("SELECT id FROM transcript_search WHERE transcript_search MATCH ?1 LIMIT 200")
            .map_err(err)?;
        Some(
            stmt.query_map([expression], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?,
        )
    };
    let documents = docs
        .into_iter()
        .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|d| {
            matched
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| d["id"] == *id))
                && filter
                    .context
                    .as_ref()
                    .is_none_or(|c| d["scope"]["context"] == *c)
                && filter.namespace.as_ref().is_none_or(|ns| {
                    d["scope"]["namespaces"]
                        .as_array()
                        .is_some_and(|n| n.iter().any(|n| n == ns))
                })
                && filter
                    .after
                    .is_none_or(|a| d["updatedAt"].as_i64().unwrap_or(0) >= a)
                && filter
                    .before
                    .is_none_or(|b| d["updatedAt"].as_i64().unwrap_or(0) <= b)
                && (filter.include_archived || d["archived"] != true)
        })
        .collect::<Vec<_>>();
    let migrated: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key='migration')",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    Ok(json!({"conversations":documents,"preferences":prefs,"migrated":migrated}))
}
async fn with_db<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("ai/history.sqlite3");
    tokio::task::spawn_blocking(move || {
        let _guard = GATE.lock().map_err(err)?;
        let mut db = open(&path)?;
        f(&mut db)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn ai_history_load(
    app: tauri::AppHandle,
    filter: Option<Search>,
) -> Result<Value, String> {
    with_db(app, move |db| load(db, filter.unwrap_or_default())).await
}
#[tauri::command]
pub async fn ai_history_sync(
    app: tauri::AppHandle,
    documents: Vec<Value>,
    deleted: Vec<String>,
    migration: bool,
) -> Result<(), String> {
    with_db(app, move |db| sync(db, documents, deleted, migration)).await
}
#[tauri::command]
pub async fn ai_history_preferences(
    app: tauri::AppHandle,
    preferences: Preferences,
) -> Result<(), String> {
    if !(1..=365).contains(&preferences.retention_days) {
        return Err("Retention must be 1–365 days".into());
    }
    with_db(app, move |db| {
        let tx = db.transaction().map_err(err)?;
        tx.execute(
            "INSERT OR REPLACE INTO settings VALUES('preferences',?1)",
            [serde_json::to_string(&preferences).map_err(err)?],
        )
        .map_err(err)?;
        purge(&tx, &preferences)?;
        tx.commit().map_err(err)
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE conversations(id TEXT PRIMARY KEY,updated INTEGER,payload TEXT);CREATE TABLE deleted(id TEXT PRIMARY KEY,at INTEGER);CREATE VIRTUAL TABLE transcript_search USING fts5(id UNINDEXED,title,body); PRAGMA secure_delete=ON; INSERT INTO transcript_search(transcript_search,rank) VALUES('secure-delete',1);").unwrap();
        db
    }
    fn doc() -> Value {
        json!({"id":"c1","title":"Payments incident","intent":"investigate","scope":{"context":"prod","namespaces":["apps"],"allNamespaces":false},"createdAt":now(),"updatedAt":now(),"sessionId":"live-session","mode":"accept","phase":"action","activePlan":{"bodyMarkdown":"secret-plan"},"messages":[{"id":"m1","role":"user","text":"CrashLoop payment"},{"id":"m2","role":"tool","text":"secret-tool","call":{"id":"call","name":"get_logs","arguments":{"credentials":"secret-args"}},"planArtifact":{"bodyMarkdown":"secret-plan"},"result":{"logs":"secret-logs"}}]})
    }
    #[test]
    fn usage_survives_storage_without_restoring_runtime_state() {
        let mut db = db();
        let mut value = doc();
        value["inputTokens"] = json!(12345);
        value["outputTokens"] = json!(678);
        value["currentContextTokens"] = json!(4000);
        value["contextBudgetTokens"] = json!(32768);
        value["contextEstimated"] = json!(true);
        value["generationMetrics"] = json!([{"id":"g1","model":"alias","resolvedModel":"actual","phase":"plan","systemTokens":100,"toolTokens":200,"historyTokens":300,"inputTokens":550,"outputTokens":40,"cachedInputTokens":300,"reasoningOutputTokens":10,"durationMs":500,"firstTokenMs":50,"toolCount":25,"secret":"discard"}]);
        sync(&mut db, vec![value], vec![], false).unwrap();
        let payload: String = db
            .query_row("SELECT payload FROM conversations WHERE id='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let saved: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(saved["inputTokens"], 12345);
        assert_eq!(saved["outputTokens"], 678);
        assert_eq!(saved["currentContextTokens"], 4000);
        assert_eq!(saved["contextBudgetTokens"], 32768);
        assert_eq!(saved["contextEstimated"], true);
        assert_eq!(saved["generationMetrics"][0]["cachedInputTokens"], 300);
        assert_eq!(saved["generationMetrics"][0]["resolvedModel"], "actual");
        assert_eq!(saved["generationMetrics"][0]["firstTokenMs"], 50);
        assert!(saved["generationMetrics"][0].get("secret").is_none());
        assert!(saved.get("sessionId").is_none());
        assert!(saved["messages"][1]["result"]["payloadOmitted"] == true);

        for invalid in [
            json!(-1),
            json!(1.5),
            json!("123"),
            json!(9_007_199_254_740_992u64),
        ] {
            let mut value = doc();
            value["inputTokens"] = invalid.clone();
            value["currentContextTokens"] = invalid;
            let saved = sanitize(&value).unwrap();
            assert_eq!(saved["inputTokens"], 0);
            assert!(saved.get("currentContextTokens").is_none());
        }
    }
    #[test]
    fn deletion_removes_transcript_and_fts_terms_from_database_bytes() {
        let path = std::env::temp_dir().join(format!(
            "kubiki-history-delete-{}-{}.sqlite3",
            std::process::id(),
            now()
        ));
        let secret = "uniquesecretretentionprobe";
        {
            let mut db = open(&path).unwrap();
            let mut value = doc();
            value["messages"][0]["text"] = json!(secret);
            sync(&mut db, vec![value], vec![], false).unwrap();
        }
        assert!(
            std::fs::read(&path)
                .unwrap()
                .windows(secret.len())
                .any(|s| s == secret.as_bytes())
        );
        {
            let mut db = open(&path).unwrap();
            sync(&mut db, vec![], vec!["c1".into()], false).unwrap();
        }
        assert!(
            !std::fs::read(&path)
                .unwrap()
                .windows(secret.len())
                .any(|s| s == secret.as_bytes())
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn sanitization_search_delete_and_stale_window_sync_are_atomic() {
        let mut db = db();
        sync(&mut db, vec![doc()], vec![], true).unwrap();
        let out = load(
            &db,
            Search {
                text: "CrashLoop".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let text = out.to_string();
        assert!(!text.contains("secret-"));
        assert!(!text.contains("live-session"));
        assert_eq!(out["conversations"][0]["mode"], "ask");
        assert_eq!(out["conversations"][0]["phase"], "plan");
        assert_eq!(out["conversations"][0]["intent"], "investigate");
        assert_eq!(out["conversations"].as_array().unwrap().len(), 1);
        sync(&mut db, vec![], vec!["c1".into()], false).unwrap();
        sync(&mut db, vec![doc()], vec![], false).unwrap();
        assert_eq!(
            load(&db, Search::default()).unwrap()["conversations"],
            json!([])
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM transcript_search", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn retention_opt_out_and_bad_input_do_not_leave_indexed_text() {
        let mut db = db();
        sync(&mut db, vec![doc()], vec![], false).unwrap();
        let prefs = Preferences {
            enabled: false,
            ..Default::default()
        };
        purge(&db, &prefs).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM transcript_search", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let mut malformed = doc();
        malformed["messages"] = json!([{"id":"x","role":"system","text":"privileged"}]);
        assert!(sync(&mut db, vec![malformed], vec![], false).is_err());
    }
}
