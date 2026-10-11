//! Where Ollama's model files and upstream llama.cpp disagree.
//!
//! Ollama writes its own GGUFs, and a few of its choices are not what the
//! pinned llama.cpp build reads. Each difference is one rule in a table
//! below, with a test beside it. A model that any rule touches is written
//! out again into the app's models folder (never in Ollama's store) with
//! the rules applied; `Summary::compat` names the rules that would change a
//! file, which is also how an older copy is found to be out of date.
//!
//! Adding a rule: add a row to `KV_RULES` or `TENSOR_RULES`, and a test.

use super::gguf::{scalar_size, Kv, TensorInfo, T_ARRAY};

/// Element types that are whole numbers (GGUF types 0-5, 10 and 11).
const INT_TYPES: [u32; 8] = [0, 1, 2, 3, 4, 5, 10, 11];

/// A change to one metadata value. Returns whether it changed anything.
struct KvRule {
    id: &'static str,
    apply: fn(&mut Kv) -> bool,
}

/// A tensor the engine must not be given. `kvs` is the file's metadata.
struct TensorRule {
    id: &'static str,
    drop: fn(&[Kv], &TensorInfo) -> bool,
}

const KV_RULES: &[KvRule] = &[KvRule {
    id: "rope_sections_pad",
    apply: pad_rope_sections,
}];

const TENSOR_RULES: &[TensorRule] = &[TensorRule {
    id: "mtp_unused",
    drop: drop_unused_mtp,
}];

/// llama.cpp reads `<arch>.rope.dimension_sections` as exactly four whole
/// numbers; Ollama's converter writes the three it has (`[11, 11, 10]`),
/// and the load stops with "wrong array length; expected 4, got 3".
fn pad_rope_sections(kv: &mut Kv) -> bool {
    const WANT: u64 = 4;
    if !kv.key.ends_with(".rope.dimension_sections") || kv.ty != T_ARRAY || kv.raw.len() < 12 {
        return false;
    }
    let (Ok(et), Ok(n)) = (
        <[u8; 4]>::try_from(&kv.raw[0..4]).map(u32::from_le_bytes),
        <[u8; 8]>::try_from(&kv.raw[4..12]).map(u64::from_le_bytes),
    ) else {
        return false;
    };
    let Some(size) = scalar_size(et).filter(|_| INT_TYPES.contains(&et)) else {
        return false;
    };
    if n >= WANT || kv.raw.len() as u64 != 12 + n * size {
        return false;
    }
    kv.raw[4..12].copy_from_slice(&WANT.to_le_bytes());
    kv.raw.resize((12 + WANT * size) as usize, 0);
    true
}

/// Ollama keeps the multi-token-prediction layers of a Qwen model under
/// `mtp.*`. The pinned build only asks for them when the file says it has
/// them (`<arch>.nextn_predict_layers`), and a file with tensors nobody asks
/// for is refused with "wrong number of tensors". Plain answers do not use
/// them, so they are left out.
fn drop_unused_mtp(kvs: &[Kv], tensor: &TensorInfo) -> bool {
    tensor.name.starts_with("mtp.")
        && !kvs
            .iter()
            .any(|kv| kv.key.ends_with(".nextn_predict_layers"))
}

/// Apply every metadata rule. Returns the ids of the rules that changed
/// something, each once.
pub fn fix_kvs(kvs: &mut [Kv]) -> Vec<&'static str> {
    KV_RULES
        .iter()
        .filter(|rule| {
            kvs.iter_mut()
                .fold(false, |changed, kv| (rule.apply)(kv) || changed)
        })
        .map(|rule| rule.id)
        .collect()
}

/// The id of the rule that leaves this tensor out of the copy, if any.
pub fn dropped_by(kvs: &[Kv], tensor: &TensorInfo) -> Option<&'static str> {
    TENSOR_RULES
        .iter()
        .find(|rule| (rule.drop)(kvs, tensor))
        .map(|rule| rule.id)
}

/// The rules that would change a file with this metadata and these tensors.
pub fn pending(kvs: &[Kv], tensors: &[TensorInfo]) -> Vec<&'static str> {
    let mut copy = kvs.to_vec();
    let mut ids = fix_kvs(&mut copy);
    for rule in TENSOR_RULES {
        if tensors.iter().any(|t| (rule.drop)(kvs, t)) {
            ids.push(rule.id);
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    const T_U32: u32 = 4;
    const T_I32: u32 = 5;
    const T_F32: u32 = 6;

    fn array(key: &str, et: u32, items: &[i64]) -> Kv {
        let size = scalar_size(et).unwrap() as usize;
        let mut raw = et.to_le_bytes().to_vec();
        raw.extend_from_slice(&(items.len() as u64).to_le_bytes());
        for v in items {
            raw.extend_from_slice(&v.to_le_bytes()[..size]);
        }
        Kv {
            key: key.into(),
            ty: T_ARRAY,
            raw,
        }
    }

    fn tensor(name: &str) -> TensorInfo {
        TensorInfo {
            name: name.into(),
            dims: vec![1],
            ty: 0,
            offset: 0,
        }
    }

    #[test]
    fn three_rope_sections_become_four_with_a_zero() {
        let mut kvs = vec![array(
            "qwen35.rope.dimension_sections",
            T_I32,
            &[11, 11, 10],
        )];
        assert_eq!(fix_kvs(&mut kvs), vec!["rope_sections_pad"]);
        assert_eq!(
            kvs[0],
            array("qwen35.rope.dimension_sections", T_I32, &[11, 11, 10, 0])
        );
    }

    #[test]
    fn rope_sections_of_any_whole_number_type_and_any_architecture_are_padded() {
        let mut kvs = vec![
            array("other.rope.dimension_sections", T_U32, &[16, 24]),
            array("x.rope.dimension_sections", 11, &[]),
        ];
        assert_eq!(fix_kvs(&mut kvs), vec!["rope_sections_pad"]);
        assert_eq!(
            kvs[0],
            array("other.rope.dimension_sections", T_U32, &[16, 24, 0, 0])
        );
        assert_eq!(
            kvs[1],
            array("x.rope.dimension_sections", 11, &[0, 0, 0, 0])
        );
    }

    #[test]
    fn four_or_more_rope_sections_and_other_keys_are_left_alone() {
        let mut kvs = vec![
            array("a.rope.dimension_sections", T_I32, &[1, 2, 3, 4]),
            array("b.rope.dimension_sections", T_I32, &[1, 2, 3, 4, 5]),
            array("a.mrope_sections", T_I32, &[11, 11, 10]),
            // Not whole numbers, and not an array: never padded.
            array(
                "c.rope.dimension_sections",
                T_F32,
                &[1.0f32.to_bits().into()],
            ),
            Kv::string("d.rope.dimension_sections", "x"),
        ];
        let before = kvs.clone();
        assert!(fix_kvs(&mut kvs).is_empty());
        assert_eq!(kvs, before);
    }

    #[test]
    fn a_rope_sections_value_that_does_not_match_its_own_length_is_not_touched() {
        let mut kv = array("a.rope.dimension_sections", T_I32, &[1, 2, 3]);
        kv.raw.pop();
        let before = kv.clone();
        assert!(fix_kvs(std::slice::from_mut(&mut kv)).is_empty());
        assert_eq!(kv, before);
    }

    #[test]
    fn mtp_tensors_are_left_out_unless_the_file_declares_them() {
        let plain = [Kv::string("general.architecture", "qwen35")];
        let declared = [Kv {
            key: "qwen35.nextn_predict_layers".into(),
            ty: T_U32,
            raw: 1u32.to_le_bytes().to_vec(),
        }];
        assert_eq!(
            dropped_by(&plain, &tensor("mtp.fc.weight")),
            Some("mtp_unused")
        );
        assert_eq!(dropped_by(&plain, &tensor("blk.0.attn_q.weight")), None);
        assert_eq!(dropped_by(&plain, &tensor("blk.0.mtp.weight")), None);
        assert_eq!(dropped_by(&declared, &tensor("mtp.fc.weight")), None);
    }

    #[test]
    fn pending_names_every_rule_that_would_change_the_file() {
        let kvs = [array("a.rope.dimension_sections", T_I32, &[1, 2, 3])];
        let tensors = [tensor("blk.0.x"), tensor("mtp.fc.weight")];
        assert_eq!(
            pending(&kvs, &tensors),
            vec!["rope_sections_pad", "mtp_unused"]
        );
        assert!(pending(&[], &[tensor("blk.0.x")]).is_empty());
    }
}
