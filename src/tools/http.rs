use std::time::Duration;

use crate::tools::ToolError;

const EXTRA_CA_ENVS: &[&str] = &["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];

fn resolve_extra_ca_path() -> Option<(&'static str, String)> {
    for name in EXTRA_CA_ENVS {
        if let Ok(val) = std::env::var(name) {
            if !val.is_empty() {
                return Some((name, val));
            }
        }
    }
    None
}

pub fn apply_extra_ca_roots(mut builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let Some((env_name, path)) = resolve_extra_ca_path() else {
        return builder;
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(
                target: "otherside::http",
                env = env_name,
                path = %path,
                error = %e,
                "extra CA bundle unreadable; falling back to system trust",
            );
            return builder;
        }
    };
    let certs = match reqwest::Certificate::from_pem_bundle(&bytes) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                target: "otherside::http",
                env = env_name,
                path = %path,
                error = %e,
                "extra CA bundle failed PEM parse; falling back to system trust",
            );
            return builder;
        }
    };
    if certs.is_empty() {
        tracing::warn!(
            target: "otherside::http",
            env = env_name,
            path = %path,
            "extra CA bundle parsed with zero certs; falling back to system trust",
        );
        return builder;
    }
    tracing::debug!(
        target: "otherside::http",
        env = env_name,
        path = %path,
        count = certs.len(),
        "loaded extra root certificates from env",
    );
    for cert in certs {
        builder = builder.add_root_certificate(cert);
    }
    builder
}

pub fn default_client(timeout_secs: u64) -> Result<reqwest::Client, ToolError> {
    apply_extra_ca_roots(reqwest::Client::builder().timeout(Duration::from_secs(timeout_secs)))
        .build()
        .map_err(|e| ToolError::InvalidArgs(format!("failed to build http client: {e}")))
}

pub fn client_with_redirects(
    timeout_secs: u64,
    max_redirects: usize,
) -> Result<reqwest::Client, ToolError> {
    apply_extra_ca_roots(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(max_redirects))
            .timeout(Duration::from_secs(timeout_secs)),
    )
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

    #[test]
    fn apply_extra_ca_roots_no_op_when_env_unset() {
        let prev = std::env::var("SSL_CERT_FILE").ok();
        unsafe { std::env::remove_var("SSL_CERT_FILE"); }
        let builder = apply_extra_ca_roots(reqwest::Client::builder());
        assert!(builder.build().is_ok(), "builder with no env cert must still build");
        if let Some(v) = prev {
            unsafe { std::env::set_var("SSL_CERT_FILE", v); }
        }
    }

    #[test]
    fn apply_extra_ca_roots_tolerates_missing_file() {
        let prev = std::env::var("SSL_CERT_FILE").ok();
        unsafe { std::env::set_var("SSL_CERT_FILE", "/definitely/does/not/exist.pem"); }
        let builder = apply_extra_ca_roots(reqwest::Client::builder());
        assert!(
            builder.build().is_ok(),
            "missing cert file must not crash the client builder",
        );
        match prev {
            Some(v) => unsafe { std::env::set_var("SSL_CERT_FILE", v); },
            None => unsafe { std::env::remove_var("SSL_CERT_FILE"); },
        }
    }

    #[test]
    fn apply_extra_ca_roots_accepts_valid_pem() {
        
        const TEST_CERT: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIBhTCCASugAwIBAgIQIRi6zePL6mKjOipn+dNuaTAKBggqhkjOPQQDAjASMRAw\n\
DgYDVQQKEwdBY21lIENvMB4XDTE3MTAyMDE5NDMwNloXDTE4MTAyMDE5NDMwNlow\n\
EjEQMA4GA1UEChMHQWNtZSBDbzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABD0d\n\
7VNhbWvZLWPuj/RtHFjvtJBEwOkhbN/BnnE8rnZR8+sbwnc/KhCk3FhnpHZnQz7B\n\
5aETbbIgmuvewdjvSBSjYzBhMA4GA1UdDwEB/wQEAwICpDATBgNVHSUEDDAKBggr\n\
BgEFBQcDATAPBgNVHRMBAf8EBTADAQH/MCkGA1UdEQQiMCCCDmxvY2FsaG9zdDo1\n\
NDUzgg4xMjcuMC4wLjE6NTQ1MzAKBggqhkjOPQQDAgNIADBFAiEA2zpJEPQyz6/l\n\
Wf86aX6PepsntZv2GYlA5UpabfT2EZICICpJ5h/iI+i341gBmLiAFQOyTDT+/wQc\n\
6MF9+Yw1Yy0t\n\
-----END CERTIFICATE-----\n";
        let tmp = std::env::temp_dir().join(format!(
            "otherside_test_ca_{}.pem",
            std::process::id(),
        ));
        std::fs::write(&tmp, TEST_CERT).unwrap();

        let prev = std::env::var("SSL_CERT_FILE").ok();
        unsafe { std::env::set_var("SSL_CERT_FILE", &tmp); }
        let builder = apply_extra_ca_roots(reqwest::Client::builder());
        let built = builder.build();
        match prev {
            Some(v) => unsafe { std::env::set_var("SSL_CERT_FILE", v); },
            None => unsafe { std::env::remove_var("SSL_CERT_FILE"); },
        }
        let _ = std::fs::remove_file(&tmp);

        assert!(
            built.is_ok(),
            "valid PEM bundle must yield a buildable client; got {:?}",
            built.err(),
        );
    }
}
