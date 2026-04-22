

pub const API_MESSAGES_URL: &str = "https://api.kimi.com/coding/v1/messages";

pub const CONSOLE_URL: &str = "https://www.kimi.com/code/console";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_url_points_at_coding_subdomain_path() {

        assert_eq!(
            API_MESSAGES_URL,
            "https://api.kimi.com/coding/v1/messages"
        );
    }

    #[test]
    fn console_url_matches_documented_dashboard() {

        assert_eq!(CONSOLE_URL, "https://www.kimi.com/code/console");
    }
}
