

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

    AllowAlways,

    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowScope {

    ProjectLocal,

    UserGlobal,
}

