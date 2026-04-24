
pub const CODE_ASSIST_ENDPOINT: &str = "https://cloudcode-pa.googleapis.com";

pub const CODE_ASSIST_API_VERSION: &str = "v1internal";

pub const OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

pub const OAUTH_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";

pub const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";

pub const OAUTH_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

pub const OAUTH_CLIENT_SECRET: &str = "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";

pub const OAUTH_SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
];

pub const OAUTH_CALLBACK_PORT_START: u16 = 8085;
pub const OAUTH_CALLBACK_PORT_END: u16 = 8115;

pub const SIGN_IN_SUCCESS_URL: &str =
    "https://developers.google.com/gemini-code-assist/auth_success_gemini";

pub fn stream_generate_content_url() -> String {
    format!("{CODE_ASSIST_ENDPOINT}/{CODE_ASSIST_API_VERSION}:streamGenerateContent")
}

pub fn load_code_assist_url() -> String {
    format!("{CODE_ASSIST_ENDPOINT}/{CODE_ASSIST_API_VERSION}:loadCodeAssist")
}

pub fn onboard_user_url() -> String {
    format!("{CODE_ASSIST_ENDPOINT}/{CODE_ASSIST_API_VERSION}:onboardUser")
}

pub fn operation_url(name: &str) -> String {
    format!("{CODE_ASSIST_ENDPOINT}/{CODE_ASSIST_API_VERSION}/{name}")
}

pub fn scopes_joined() -> String {
    OAUTH_SCOPES.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_urls_match_upstream() {
        assert_eq!(CODE_ASSIST_ENDPOINT, "https://cloudcode-pa.googleapis.com");
        assert_eq!(CODE_ASSIST_API_VERSION, "v1internal");
        assert_eq!(
            stream_generate_content_url(),
            "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"
        );
    }

    #[test]
    fn oauth_client_id_matches_upstream_desktop_app() {
        assert!(OAUTH_CLIENT_ID.ends_with(".apps.googleusercontent.com"));
    }

    #[test]
    fn scopes_include_cloud_platform_and_userinfo_email() {
        let joined = scopes_joined();
        assert!(joined.contains("cloud-platform"));
        assert!(joined.contains("userinfo.email"));
    }
}
