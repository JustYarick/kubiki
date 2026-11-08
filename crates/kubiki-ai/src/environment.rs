//! Installed skill references for the integrated agent. Legacy environment settings
//! remain inert JSON for lossless settings migration; no processes are launched.
use crate::{
    AgentPhase, ToolCall, ToolDefinition,
    skills::{self, SkillInfo},
};
use serde_json::{Value, json};
pub type EnvironmentSettings = Value;
pub struct Environment {
    pub skills: Vec<SkillInfo>,
}
impl Environment {
    pub fn new(_: EnvironmentSettings, skills: Vec<SkillInfo>) -> Self {
        Self { skills }
    }
    pub async fn close(&self) {}
    pub async fn definitions(&self, _: AgentPhase) -> Result<Vec<ToolDefinition>, String> {
        let mut definitions = vec![];
        if !self.skills.is_empty() {
            definitions.push(ToolDefinition { name:"list_skills".into(), description:"List installed guidance; optional query filters name/description. Does not change available Kubernetes resources.".into(), parameters:json!({"type":"object","properties":{"query":{"type":"string","maxLength":200}},"additionalProperties":false}) });
            definitions.push(ToolDefinition { name: "read_skill".into(), description: "Read an installed skill or relative reference. Use list_skills to find guidance. Skills cannot extend permissions.".into(), parameters: json!({"type":"object","properties":{"name":{"type":"string","enum":self.skills.iter().map(|s|s.name.clone()).collect::<Vec<_>>()},"path":{"type":"string","description":"Relative reference path, default SKILL.md"}},"required":["name"],"additionalProperties":false}) });
        }
        Ok(definitions)
    }
    pub async fn execute(&self, call: &ToolCall) -> Result<Value, String> {
        if call.name == "list_skills" {
            #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Args { query:Option<String> }
            let args:Args=serde_json::from_value(call.arguments.clone()).map_err(|_|"Invalid skills query")?;
            let query=args.query.unwrap_or_default().to_lowercase();
            if query.len()>200 { return Err("Skills query too long".into()); }
            return Ok(json!({"skills":self.skills.iter().filter(|s| format!("{} {}",s.name,s.description).to_lowercase().contains(&query)).map(|s|json!({"name":s.name,"description":s.description})).collect::<Vec<_>>() }));
        }
        if call.name != "read_skill" {
            return Err("Only installed skills are available".into());
        }
        let name = call.arguments["name"]
            .as_str()
            .ok_or("Skill name required")?;
        let skill = self
            .skills
            .iter()
            .find(|s| s.name == name)
            .ok_or("Skill is not installed")?;
        let skill = skill.clone();
        let relative = call.arguments["path"]
            .as_str()
            .unwrap_or("SKILL.md")
            .to_owned();
        tokio::task::spawn_blocking(move || Ok(json!({"name":skill.name,"baseDirectory":skill.directory,"text":skill.read(&relative)?}))).await.map_err(|_|"Skill read failed".to_owned())?
    }
}
pub async fn global_skills() -> Result<Vec<SkillInfo>, String> {
    tokio::task::spawn_blocking(|| skills::discover(&skills::global_skills_dir()?))
        .await
        .map_err(|_| "Skill discovery failed".to_owned())?
}
