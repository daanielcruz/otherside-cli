use std::time::Duration;

use crate::tools::ToolError;

pub fn default_client(timeout_secs: u64) -> Result<reqwest::Client, ToolError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| ToolError::InvalidArgs(format!("failed to build http client: {e}")))
}

pub fn client_with_redirects(
    timeout_secs: u64,
    max_redirects: usize,
) -> Result<reqwest::Client, ToolError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(max_redirects))
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| ToolError::InvalidArgs(format!("failed to build http client: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_client_builds() {
        assert!(default_client(30).is_ok());
    }

    #[test]
    fn client_with_redirects_builds() {
        assert!(client_with_redirects(30, 5).is_ok());
    }
}
