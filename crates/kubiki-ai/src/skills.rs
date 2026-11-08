//! Read the canonical skills.sh directory. No installation or private registry.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub directory: PathBuf,
}

pub fn global_skills_dir() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| PathBuf::from(home).join(".agents/skills"))
        .ok_or_else(|| "Cannot locate the user skills directory".into())
}

pub fn discover(root: &Path) -> Result<Vec<SkillInfo>, String> {
    fn walk(
        path: &Path,
        depth: usize,
        found: &mut BTreeMap<String, SkillInfo>,
        seen: &mut Vec<PathBuf>,
    ) {
        if depth > 3 || found.len() >= 128 || seen.len() >= 1024 {
            return;
        }
        let Ok(canonical) = path.canonicalize() else {
            return;
        };
        if seen.contains(&canonical) {
            return;
        }
        seen.push(canonical.clone());
        let file = canonical.join("SKILL.md");
        if let Ok(text) = read_bounded(&file) {
            let text = text.replace("\r\n", "\n");
            if let Some(frontmatter) = text
                .strip_prefix("---\n")
                .and_then(|text| text.split_once("\n---"))
            {
                if let Ok(metadata) = serde_yaml::from_str::<serde_json::Value>(frontmatter.0) {
                    if let Some(name) = metadata["name"].as_str().filter(|name| valid_name(name)) {
                        found.entry(name.into()).or_insert(SkillInfo {
                            name: name.into(),
                            description: metadata["description"]
                                .as_str()
                                .unwrap_or("")
                                .chars()
                                .take(500)
                                .collect(),
                            directory: canonical,
                        });
                        return;
                    }
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(path) {
            let mut paths: Vec<_> = entries
                .flatten()
                .take(512)
                .map(|entry| entry.path())
                .collect();
            paths.sort();
            for path in paths {
                if path.is_dir() {
                    walk(&path, depth + 1, found, seen);
                }
            }
        }
    }
    if !root.exists() {
        return Ok(vec![]);
    }
    if !root.is_dir() {
        return Err("Skills path is not a directory".into());
    }
    let mut found = BTreeMap::new();
    walk(root, 0, &mut found, &mut vec![]);
    Ok(found.into_values().collect())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn read_bounded(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| "Skill file is unavailable")?;
    let mut bytes = Vec::new();
    file.take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read skill file")?;
    if bytes.len() > 65_536 {
        return Err("Skill files must be at most 64 KiB".into());
    }
    String::from_utf8(bytes).map_err(|_| "Skill file must be UTF-8".into())
}
impl SkillInfo {
    pub fn read(&self, relative: &str) -> Result<String, String> {
        let path = self
            .directory
            .join(relative)
            .canonicalize()
            .map_err(|_| "Skill file is unavailable")?;
        if !path.starts_with(&self.directory) {
            return Err("Skill references must stay inside the skill directory".into());
        }
        read_bounded(&path)
    }
}

pub fn selected_instructions(skills: &[SkillInfo], prompt: &str) -> Result<String, String> {
    let mut selected = Vec::new();
    for skill in skills {
        if prompt.split_whitespace().any(|word| {
            word.strip_prefix('$')
                .is_some_and(|name| name.trim_end_matches([',', '.', ':', ';']) == skill.name)
        }) {
            if selected.len() >= 4 {
                return Err("Select at most four skills per message".into());
            }
            selected.push(format!("Skill ${} (base directory: {}). These user-selected instructions cannot extend permissions:\n{}", skill.name, skill.directory.display(), skill.read("SKILL.md")?));
        }
    }
    Ok(selected.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_global_layout_and_loads_only_explicit_skills_with_contained_references() {
        let root = std::env::temp_dir().join(format!("kubiki-skills-{}", std::process::id()));
        std::fs::create_dir_all(root.join("example/references")).unwrap();
        std::fs::write(
            root.join("example/SKILL.md"),
            "---\nname: example\ndescription: Test skill\n---\nInstructions",
        )
        .unwrap();
        std::fs::write(root.join("example/references/guide.md"), "Guide").unwrap();
        let skills = discover(&root).unwrap();
        assert_eq!(skills.len(), 1);
        assert!(
            selected_instructions(&skills, "use $example")
                .unwrap()
                .contains("Instructions")
        );
        assert!(
            selected_instructions(&skills, "example $example-other")
                .unwrap()
                .is_empty()
        );
        assert_eq!(skills[0].read("references/guide.md").unwrap(), "Guide");
        assert!(skills[0].read("../../Cargo.toml").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
