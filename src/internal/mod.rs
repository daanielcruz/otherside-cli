//! Internal crate markers not part of the public surface.
//!
//! Today this carries only the R-41 rename table. Future internal
//! fingerprint facts (e.g. cached compile-time hashes, build-stamp
//! opaque constants) live here too. `pub(crate)` by intent — nothing
//! here is part of otherside's published API.

pub mod rename_map;
