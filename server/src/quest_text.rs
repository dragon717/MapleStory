//! Offline quest display-text catalog (multilingual).
//!
//! Source of truth: `shared/quest-text.json` (schemaVersion 1, produced by
//! `scripts/quest_i18n/extract_questinfo.py` + `apply_zh.py`).  The server
//! ships this catalog so `questList` / `questUpdate` can carry authoritative
//! per-player-locale text and never depend on client-side translation tables.
//!
//! Language convention follows the rest of the project: `zh` is the default
//! UI language and `en` is the `?lang=en` override.  A missing locale falls
//! back to `en` (the corpus guarantees every entry has English); an unknown
//! quest id degrades to the id as the name and an empty summary so a quest
//! log row can never produce blank text.

use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

/// UI languages the server knows how to emit.  `zh` matches the product
/// default (`client/src/app/i18n.ts` resolves anything that is not an
/// explicit English request to Chinese).
pub const LANG_ZH: &str = "zh";
pub const LANG_EN: &str = "en";

pub fn normalize_lang(raw: Option<&str>) -> &'static str {
    match raw {
        Some("en") | Some("EN") | Some("En") => LANG_EN,
        _ => LANG_ZH,
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct QuestTextCorpus {
    /// quest id -> per-language texts.  Only `name` and `log` are consumed by
    /// the quest-log push; the rest of the corpus (raw lines, meta, sources)
    /// is intentionally ignored by serde.
    #[serde(default)]
    pub quests: BTreeMap<String, QuestTextEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct QuestTextEntry {
    /// locale -> quest name (en always present in the corpus).
    #[serde(default)]
    pub name: BTreeMap<String, String>,
    /// locale -> quest-log summary shown in the quest log panel.
    #[serde(default)]
    pub log: BTreeMap<String, String>,
}

impl QuestTextCorpus {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let corpus: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        Ok(corpus)
    }

    /// Best text for a locale: exact locale first, English second.
    fn pick<'a>(texts: &'a BTreeMap<String, String>, lang: &str) -> Option<&'a str> {
        texts
            .get(lang)
            .or_else(|| texts.get(LANG_EN))
            .map(String::as_str)
    }

    /// Display name for the quest in the given locale.  Falls back to en and
    /// finally to the quest id itself so the field is never empty.
    pub fn name(&self, quest_id: &str, lang: &str) -> String {
        self.quests
            .get(quest_id)
            .and_then(|entry| Self::pick(&entry.name, lang))
            .unwrap_or(quest_id)
            .to_owned()
    }

    /// Quest-log summary for the locale.  Falls back to en, then to an empty
    /// string (quests without authored summary text have nothing to show).
    pub fn summary(&self, quest_id: &str, lang: &str) -> String {
        self.quests
            .get(quest_id)
            .and_then(|entry| Self::pick(&entry.log, lang))
            .unwrap_or_default()
            .to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn corpus() -> QuestTextCorpus {
        serde_json::from_str(
            r#"{
                "schemaVersion": 1,
                "quests": {
                    "1021": {
                        "name": {"en": "Roger's Apple", "zh": "罗杰的苹果"},
                        "log": {
                            "en": "Talk to Roger on Maple Road.",
                            "zh": "前往冒险岛路与罗杰对话。"
                        }
                    },
                    "internal-only": {
                        "name": {"en": "Training Camp Check", "zh": "训练营任务确认"}
                    }
                }
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn name_resolves_locale_then_english_then_id() {
        let c = corpus();
        assert_eq!(c.name("1021", "zh"), "罗杰的苹果");
        assert_eq!(c.name("1021", "en"), "Roger's Apple");
        // Missing requested locale falls back to English.
        assert_eq!(c.name("1021", "fr"), "Roger's Apple");
        // Unknown quest degrades to the quest id (never blank).
        assert_eq!(c.name("nope", "zh"), "nope");
        assert_eq!(c.name("internal-only", "zh"), "训练营任务确认");
    }

    #[test]
    fn summary_falls_back_to_english_and_may_be_empty() {
        let c = corpus();
        assert_eq!(c.summary("1021", "zh"), "前往冒险岛路与罗杰对话。");
        assert_eq!(c.summary("1021", "en"), "Talk to Roger on Maple Road.");
        // Quest without a log entry has no summary to show.
        assert_eq!(c.summary("internal-only", "zh"), "");
        assert_eq!(c.summary("nope", "zh"), "");
    }

    #[test]
    fn normalize_lang_maps_only_explicit_english_requests() {
        assert_eq!(normalize_lang(Some("en")), "en");
        assert_eq!(normalize_lang(None), "zh");
        assert_eq!(normalize_lang(Some("zh")), "zh");
        assert_eq!(normalize_lang(Some("fr")), "zh");
        assert_eq!(normalize_lang(Some("EN")), "en");
    }

    #[test]
    fn real_corpus_loads_and_has_the_gameplay_quest_text() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shared/quest-text.json");
        let corpus = QuestTextCorpus::load(&path).expect("shared/quest-text.json must parse");
        assert!(!corpus.quests.is_empty(), "corpus must not be empty");
        assert_eq!(corpus.name("36301", "zh"), "[楓之谷世界的冒險家] 插著楓葉的少女");
        assert!(!corpus.summary("36301", "zh").is_empty());
        assert!(!corpus.quests.contains_key("1021"));
        assert!(!corpus.quests.contains_key("maple-road-training"));
    }
}
