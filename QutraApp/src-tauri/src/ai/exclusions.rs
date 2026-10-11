//! The user's exclusions (Settings → Privacy): names, paths, domains and
//! patterns that must never leave the machine. The page keeps them in the
//! document store; the core reads them there itself before a cloud turn or
//! its preview, so what is masked never depends on what the page sends.
//! When they cannot be read, nothing goes: privacy wins over the turn.

use std::collections::HashSet;

use sqlx::{Row, SqlitePool};
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool};

use super::mask::MAX_TERMS;

/// The database the app preloads and the page writes through.
const DATABASE: &str = "sqlite:contextos.db";

/// Why the exclusions could not be read. Commands turn it into their own
/// generic refusal, so the page needs no new wording.
pub const UNREADABLE: &str = "exclusions_unreadable";

/// The excluded values in stored rows (`{"kind": …, "value": "Acme Corp"}`):
/// trimmed, repeats in any case dropped, at most `MAX_TERMS`. A row that is
/// not JSON or has no text value has nothing to mask, so it adds nothing.
pub fn terms_from_rows(rows: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    rows.into_iter()
        .filter_map(|row| value_of(&row))
        .filter(|value| seen.insert(value.to_lowercase()))
        .take(MAX_TERMS)
        .collect()
}

fn value_of(row: &str) -> Option<String> {
    let data: serde_json::Value = serde_json::from_str(row).ok()?;
    let value = data.get("value")?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Read-only: the store's schema is the page's, and this never changes it.
pub async fn load_terms(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query("SELECT data FROM records WHERE collection = 'exclusions'")
        .fetch_all(pool)
        .await?;
    let data = rows
        .iter()
        .map(|row| row.try_get::<String, _>("data"))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(terms_from_rows(data))
}

/// The exclusions from the store the SQL plugin has loaded. Fails closed:
/// a store that is not loaded or cannot be read is an error, never an
/// empty list.
pub async fn load_from(instances: &DbInstances) -> Result<Vec<String>, &'static str> {
    // Clone the pool so the plugin's lock is not held while the query runs.
    let pool = match instances.0.read().await.get(DATABASE) {
        Some(DbPool::Sqlite(pool)) => pool.clone(),
        None => return Err(UNREADABLE),
    };
    load_terms(&pool).await.map_err(|error| {
        eprintln!("[Qutra Labs] reading exclusions failed: {error}");
        UNREADABLE
    })
}

/// The exclusions for a command about to send, or show, what goes to a
/// cloud service.
pub async fn for_cloud(app: &tauri::AppHandle) -> Result<Vec<String>, &'static str> {
    match app.try_state::<DbInstances>() {
        Some(instances) => load_from(&instances).await,
        None => Err(UNREADABLE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn rows(list: &[&str]) -> Vec<String> {
        list.iter().map(|row| row.to_string()).collect()
    }

    /// A file database with the app's real migrations.
    async fn app_database(dir: &std::path::Path) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(dir.join("contextos.db"))
                    .create_if_missing(true),
            )
            .await
            .expect("open test database");
        for migration in crate::migrations() {
            sqlx::raw_sql(migration.sql)
                .execute(&pool)
                .await
                .unwrap_or_else(|error| panic!("migration {}: {error}", migration.version));
        }
        pool
    }

    async fn insert(pool: &SqlitePool, collection: &str, id: &str, data: &str) {
        sqlx::query("INSERT INTO records (collection, id, data) VALUES (?1, ?2, ?3)")
            .bind(collection)
            .bind(id)
            .bind(data)
            .execute(pool)
            .await
            .unwrap();
    }

    #[test]
    fn values_are_taken_trimmed_once_each() {
        let terms = terms_from_rows(rows(&[
            r#"{"id":"exc_1","kind":"app","value":"Acme Corp","note":"","demo":false}"#,
            r#"{"id":"exc_2","kind":"path","value":"  C:\\Clients\\Acme  "}"#,
            r#"{"id":"exc_3","kind":"domain","value":"ACME CORP"}"#,
            r#"{"id":"exc_4","kind":"pattern","value":"acme.internal"}"#,
        ]));
        assert_eq!(terms, ["Acme Corp", r"C:\Clients\Acme", "acme.internal"]);
    }

    #[test]
    fn rows_without_a_text_value_add_nothing() {
        let terms = terms_from_rows(rows(&[
            "not json",
            r#"{"id":"exc_1","kind":"app"}"#,
            r#"{"id":"exc_2","value":42}"#,
            r#"{"id":"exc_3","value":null}"#,
            r#"{"id":"exc_4","value":"   "}"#,
            r#"["value","Acme"]"#,
            r#"{"id":"exc_5","value":"Kept"}"#,
        ]));
        assert_eq!(terms, ["Kept"]);
    }

    #[test]
    fn at_most_the_mask_limit_is_kept() {
        let many = (0..MAX_TERMS + 20).map(|n| format!(r#"{{"value":"term {n}"}}"#));
        assert_eq!(terms_from_rows(many).len(), MAX_TERMS);
    }

    #[tokio::test]
    async fn only_exclusion_rows_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let pool = app_database(dir.path()).await;
        insert(&pool, "exclusions", "exc_1", r#"{"value":"Acme Corp"}"#).await;
        insert(&pool, "exclusions", "exc_2", "not json").await;
        insert(&pool, "notes", "n1", r#"{"value":"Not excluded"}"#).await;

        assert_eq!(load_terms(&pool).await.unwrap(), ["Acme Corp"]);
        pool.close().await;
    }

    #[tokio::test]
    async fn the_loaded_store_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let pool = app_database(dir.path()).await;
        insert(&pool, "exclusions", "exc_1", r#"{"value":"Acme Corp"}"#).await;
        let instances = DbInstances::default();
        instances
            .0
            .write()
            .await
            .insert(DATABASE.into(), DbPool::Sqlite(pool.clone()));

        assert_eq!(load_from(&instances).await.unwrap(), ["Acme Corp"]);
        pool.close().await;
    }

    #[tokio::test]
    async fn a_store_that_is_not_loaded_or_not_readable_fails_closed() {
        assert_eq!(load_from(&DbInstances::default()).await, Err(UNREADABLE));

        // Loaded, but without the document store's tables.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let instances = DbInstances::default();
        instances
            .0
            .write()
            .await
            .insert(DATABASE.into(), DbPool::Sqlite(pool.clone()));
        assert_eq!(load_from(&instances).await, Err(UNREADABLE));
        pool.close().await;
    }
}
