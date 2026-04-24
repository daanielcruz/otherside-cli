
#[derive(Debug, Clone, Copy)]
pub struct GeminiModel {
    pub id: &'static str,
    pub display_name: &'static str,
    pub context_window: u64,
}

pub const CATALOG: &[GeminiModel] = &[
    GeminiModel {
        id: "gemini-3.1-pro-preview",
        display_name: "Gemini 3.1 Pro Preview",
        context_window: 1_000_000,
    },
    GeminiModel {
        id: "gemini-3-pro-preview",
        display_name: "Gemini 3 Pro Preview",
        context_window: 1_000_000,
    },
    GeminiModel {
        id: "gemini-3-flash-preview",
        display_name: "Gemini 3 Flash Preview",
        context_window: 1_000_000,
    },
    GeminiModel {
        id: "gemini-2.5-pro",
        display_name: "Gemini 2.5 Pro",
        context_window: 2_000_000,
    },
    GeminiModel {
        id: "gemini-2.5-flash",
        display_name: "Gemini 2.5 Flash",
        context_window: 1_000_000,
    },
    GeminiModel {
        id: "gemini-2.5-flash-lite",
        display_name: "Gemini 2.5 Flash Lite",
        context_window: 1_000_000,
    },
];

pub fn by_id(id: &str) -> Option<&'static GeminiModel> {
    CATALOG.iter().find(|m| m.id == id)
}

pub fn display_name_for(id: &str) -> &'static str {
    by_id(id).map(|m| m.display_name).unwrap_or("Gemini")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_catalog_slug_matches_provider_defaults_row() {
        assert!(
            by_id("gemini-3-pro-preview").is_some(),
            "the default_model_for(GeminiCli) slug must resolve in the catalog"
        );
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|m| m.id).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn unknown_slug_falls_back_to_plain_gemini_label() {
        assert_eq!(display_name_for("gemini-unknown-slug"), "Gemini");
    }
}
