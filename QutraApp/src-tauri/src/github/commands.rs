//! Narrow GitHub broker commands. No free-form URL from the renderer.

use super::broker::{self, BrokerResponse, DeviceCodeResponse, DevicePollResponse};

#[tauri::command]
pub async fn github_api_get(
    path: String,
    if_none_match: Option<String>,
) -> Result<BrokerResponse, String> {
    broker::api_get(path, if_none_match).await
}

#[tauri::command]
pub async fn github_graphql(login: String) -> Result<BrokerResponse, String> {
    broker::graphql_contributions(login).await
}

#[tauri::command]
pub async fn github_device_start(client_id: String) -> Result<DeviceCodeResponse, String> {
    broker::device_start(client_id).await
}

#[tauri::command]
pub async fn github_device_poll(
    client_id: String,
    device_code: String,
) -> Result<DevicePollResponse, String> {
    broker::device_poll(client_id, device_code).await
}
