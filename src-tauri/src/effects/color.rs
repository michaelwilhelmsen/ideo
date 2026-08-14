//! The working space, written down — lifted from `spikes/post-effects/src/color.rs`.
//!
//! #52's own warning is that getting the conversion wrong makes every arm of a
//! comparison wrong in the same direction, so the comparison proves nothing.
//! The same is true here for a different reason: the GPU gets sRGB→linear free
//! in hardware from `SRGB8_ALPHA8` sampling, and if this file disagreed with it
//! then a duotone would visibly shift the moment the user switched from an
//! ordered kernel to a diffusion one — same inks, same image, no explanation.
//! So the transfer is stated exactly once, exactly, and both paths go through
//! their own copy of the same function.
//!
//! **Exact sRGB, not `powf(x, 2.2)`.** A ~2.0 approximation is reported to be
//! visually indistinguishable for dithering, but that is a claim about results,
//! and an approximation here would be a second uncontrolled variable sitting
//! next to the parity we are asserting.

/// sRGB-encoded byte to linear light in `0.0..=1.0`.
///
/// IEC 61966-2-1 electro-optical transfer function.
pub fn srgb_to_linear(v: u8) -> f32 {
    let s = v as f32 / 255.0;
    if s <= 0.040_45 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light back to an sRGB-encoded byte, rounded and clamped.
pub fn linear_to_srgb(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0 + 0.5) as u8
}

/// Relative luminance of a linear-light RGB triple (Rec. 709 / sRGB primaries).
///
/// The coefficients are the ones sRGB's own primaries imply, applied to
/// *linear* values — applying them to encoded bytes is the classic mistake this
/// module exists to prevent.
pub fn luminance(c: [f32; 3]) -> f32 {
    0.212_639 * c[0] + 0.715_169 * c[1] + 0.072_192 * c[2]
}

/// A lookup table for the linear → sRGB direction.
///
/// The index is `sqrt(v)`, not `v`. A table indexed linearly spends almost all
/// its entries on the highlights, where sRGB is nearly straight, and almost
/// none on the shadows, where it bends hardest — the exact opposite of where
/// the resolution is needed. Taking the square root first spreads the entries
/// roughly the way the transfer function does, which is what lets 4096 of them
/// land within one byte of exact everywhere.
///
/// #52 measured this as the most expensive **mandatory** step in the whole set:
/// 44.9 ms at 2560×1440 against 10.9 ms for the worst ordered dither, down to
/// 9.4 ms through the table. Decoding needs no table at all — there are only
/// 256 possible inputs.
pub struct SrgbEncodeTable(Box<[u8; Self::N]>);

impl SrgbEncodeTable {
    const N: usize = 4096;

    pub fn new() -> Self {
        let mut t = Box::new([0u8; Self::N]);
        for (i, e) in t.iter_mut().enumerate() {
            let s = i as f32 / (Self::N - 1) as f32;
            *e = linear_to_srgb(s * s);
        }
        Self(t)
    }

    #[inline]
    pub fn encode(&self, v: f32) -> u8 {
        let i = (v.clamp(0.0, 1.0).sqrt() * (Self::N - 1) as f32 + 0.5) as usize;
        self.0[i.min(Self::N - 1)]
    }
}

impl Default for SrgbEncodeTable {
    fn default() -> Self {
        Self::new()
    }
}

/// `#RRGGBB` as three linear-light channels.
///
/// Returns `None` rather than panicking: the hex arrives from a treatment, and
/// a treatment can be hand-edited in a manifest.
pub fn linear_from_hex(hex: &str) -> Option<[f32; 3]> {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    if h.len() != 6 {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([
        srgb_to_linear(byte(0)?),
        srgb_to_linear(byte(2)?),
        srgb_to_linear(byte(4)?),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_round_trips_every_byte() {
        // Checked exhaustively rather than at samples: if the pair is not an
        // exact inverse over the whole domain then the GPU/CPU parity assertion
        // is measuring conversion drift rather than the kernels.
        for v in 0u8..=255 {
            assert_eq!(linear_to_srgb(srgb_to_linear(v)), v, "byte {v}");
        }
    }

    #[test]
    fn the_encoded_midpoint_is_not_half_the_light() {
        // The whole reason the working space matters: sRGB 128 is about 21.6%
        // of the light, not 50%. A kernel that thresholds encoded bytes at 128
        // is thresholding at the wrong place by more than a factor of two.
        let mid = srgb_to_linear(128);
        assert!(
            (mid - 0.2158).abs() < 0.001,
            "sRGB 128 is {mid} in linear light"
        );
    }

    #[test]
    fn the_endpoints_are_exact() {
        assert_eq!(srgb_to_linear(0), 0.0);
        assert_eq!(srgb_to_linear(255), 1.0);
        assert_eq!(linear_to_srgb(0.0), 0);
        assert_eq!(linear_to_srgb(1.0), 255);
    }

    #[test]
    fn luminance_of_white_is_one() {
        assert!((luminance([1.0, 1.0, 1.0]) - 1.0).abs() < 1e-5);
        assert_eq!(luminance([0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn green_carries_most_of_the_luminance() {
        assert!(luminance([0.0, 1.0, 0.0]) > luminance([1.0, 0.0, 0.0]));
        assert!(luminance([1.0, 0.0, 0.0]) > luminance([0.0, 0.0, 1.0]));
    }

    #[test]
    fn the_encode_table_is_within_one_byte_of_exact() {
        let t = SrgbEncodeTable::new();
        let mut worst = 0i32;
        for i in 0..=100_000u32 {
            let v = i as f32 / 100_000.0;
            let d = (t.encode(v) as i32 - linear_to_srgb(v) as i32).abs();
            worst = worst.max(d);
        }
        assert!(worst <= 1, "table was off by {worst} bytes");
    }

    #[test]
    fn a_hex_becomes_the_light_it_names() {
        assert!((luminance(linear_from_hex("#FFFFFF").unwrap()) - 1.0).abs() < 1e-5);
        assert_eq!(linear_from_hex("#000000").unwrap(), [0.0, 0.0, 0.0]);
        assert_eq!(linear_from_hex("D9662C"), linear_from_hex("#D9662C"));
    }

    #[test]
    fn a_hand_edited_colour_is_refused_rather_than_panicking() {
        // The hex comes off a treatment, and a treatment lives in a manifest
        // somebody can open in a text editor.
        assert!(linear_from_hex("#GGGGGG").is_none());
        assert!(linear_from_hex("cerulean").is_none());
        assert!(linear_from_hex("").is_none());
    }
}
