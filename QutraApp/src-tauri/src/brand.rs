//! The window icon follows the theme: the cyan Q in hud
//! dark, the red Q everywhere else. Both icons are compiled into the binary
//! by `scripts/build-q-icons.mjs` -> `icons/window-*.png`; the renderer only
//! names a variant. It never supplies image bytes or a path, so a compromised
//! page can at most switch between the two marks the app ships.

use serde::Deserialize;
use tauri::image::Image;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrandVariant {
    Cyan,
    Red,
}

impl BrandVariant {
    fn png(self) -> &'static [u8] {
        match self {
            Self::Cyan => include_bytes!("../icons/window-cyan.png"),
            Self::Red => include_bytes!("../icons/window-red.png"),
        }
    }

    pub fn image(self) -> Result<Image<'static>, String> {
        Image::from_bytes(self.png()).map_err(|e| format!("bundled {self:?} window icon: {e}"))
    }
}

/// Set the window and taskbar icon to one of the two bundled marks.
#[tauri::command]
pub fn set_brand_window_icon(window: tauri::Window, variant: BrandVariant) -> Result<(), String> {
    window.set_icon(variant.image()?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_bundled_variants_deserialize() {
        assert_eq!(
            serde_json::from_str::<BrandVariant>("\"cyan\"").unwrap(),
            BrandVariant::Cyan
        );
        assert_eq!(
            serde_json::from_str::<BrandVariant>("\"red\"").unwrap(),
            BrandVariant::Red
        );
        for rejected in [
            "\"Cyan\"",
            "\"blue\"",
            "\"../icons/icon.png\"",
            "\"C:\\\\evil.png\"",
            "{\"path\":\"x.png\"}",
            "\"\"",
        ] {
            assert!(
                serde_json::from_str::<BrandVariant>(rejected).is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn both_bundled_icons_decode_at_64_px() {
        for variant in [BrandVariant::Cyan, BrandVariant::Red] {
            let image = variant.image().expect("decode");
            assert_eq!((image.width(), image.height()), (64, 64), "{variant:?}");
        }
    }

    #[test]
    fn the_variants_are_different_images() {
        assert_ne!(BrandVariant::Cyan.png(), BrandVariant::Red.png());
    }
}
