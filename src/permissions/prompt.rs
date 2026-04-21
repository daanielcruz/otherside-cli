

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptChoice {
    Yes,
    No,
    AlwaysAllow(AllowScope),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionResponse {

    Allow,

    AllowSession,

    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowScope {

    ProjectLocal,

    UserGlobal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_variants_debug() {
        assert_eq!(format!("{:?}", PromptChoice::Yes), "Yes");
        assert_eq!(format!("{:?}", AllowScope::UserGlobal), "UserGlobal");
    }
}
