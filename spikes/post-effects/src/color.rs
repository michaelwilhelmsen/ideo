//! The working space, written down.
//!
//! #36's one settled finding is "work in linear light", and its own warning is
//! that getting the conversion wrong makes *both* arms of the A/B wrong in the
//! same direction, so the A/B proves nothing. So the conversion is stated here
//! exactly once, exact rather than approximated, and every kernel goes through
//! it.
//!
//! **Exact sRGB, not `pow(x, 2.2)`.** The research notes that a ~2.0 gamma
//! approximation is reported to be visually indistinguishable for dithering.
//! That may well be true, but it is a claim about the *result*, and this crate
//! exists to produce evidence about results — an approximation here would put a
//! second uncontrolled variable next to the one being measured. The exact
//! transfer function costs one branch per channel and is used everywhere.

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
/// The coefficients are the ones sRGB's own primaries imply, and they are
/// applied to *linear* values — applying them to encoded bytes is the classic
/// mistake this module exists to prevent.
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
/// land within one byte of exact everywhere ([`tests::the_encode_table_is_within_one_byte_of_exact`]).
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

/// An image held as linear-light RGB, which is the only form the kernels see.
#[derive(Clone)]
pub struct LinearImage {
    pub width: u32,
    pub height: u32,
    pub px: Vec<[f32; 3]>,
}

impl LinearImage {
    pub fn new(width: u32, height: u32, px: Vec<[f32; 3]>) -> Self {
        assert_eq!(px.len(), (width as usize) * (height as usize));
        Self { width, height, px }
    }

    pub fn len(&self) -> usize {
        self.px.len()
    }

    pub fn is_empty(&self) -> bool {
        self.px.is_empty()
    }

    /// Decode an 8-bit RGB image into linear light.
    pub fn from_rgb8(img: &image::RgbImage) -> Self {
        // A 256-entry table: the transfer function is per-byte, and calling
        // `powf` 11 million times to decode a 2560×1440 frame would show up in
        // the benchmark as if it were kernel cost.
        let lut: [f32; 256] = std::array::from_fn(|i| srgb_to_linear(i as u8));
        let px = img
            .pixels()
            .map(|p| [lut[p[0] as usize], lut[p[1] as usize], lut[p[2] as usize]])
            .collect();
        Self::new(img.width(), img.height(), px)
    }

    /// Encode back to 8-bit sRGB, exactly — one `powf` per channel.
    pub fn to_rgb8(&self) -> image::RgbImage {
        let mut out = image::RgbImage::new(self.width, self.height);
        for (dst, src) in out.pixels_mut().zip(self.px.iter()) {
            *dst = image::Rgb([
                linear_to_srgb(src[0]),
                linear_to_srgb(src[1]),
                linear_to_srgb(src[2]),
            ]);
        }
        out
    }

    /// The same encode through [`SrgbEncodeTable`].
    ///
    /// Here because the exact version turned out to be the most expensive
    /// *mandatory* step in the whole benchmark, and a table removes almost all
    /// of it. Reporting only the `powf` number would price linear light as
    /// something it is not.
    pub fn to_rgb8_via_table(&self, table: &SrgbEncodeTable) -> image::RgbImage {
        let mut out = image::RgbImage::new(self.width, self.height);
        for (dst, src) in out.pixels_mut().zip(self.px.iter()) {
            *dst = image::Rgb([
                table.encode(src[0]),
                table.encode(src[1]),
                table.encode(src[2]),
            ]);
        }
        out
    }

    /// Box-filtered downscale, done in linear light.
    ///
    /// Here for the same reason the rest of the module is: resampling encoded
    /// sRGB averages the wrong numbers, and the contact sheets are viewed
    /// downscaled, so a wrong resize would misreport what the kernels did.
    pub fn downscale_to_width(&self, target: u32) -> LinearImage {
        if target >= self.width {
            return self.clone();
        }
        let scale = self.width as f32 / target as f32;
        let th = ((self.height as f32 / scale).round() as u32).max(1);
        let mut px = Vec::with_capacity((target as usize) * (th as usize));
        for y in 0..th {
            let y0 = (y as f32 * scale) as u32;
            let y1 = (((y + 1) as f32 * scale) as u32)
                .min(self.height)
                .max(y0 + 1);
            for x in 0..target {
                let x0 = (x as f32 * scale) as u32;
                let x1 = (((x + 1) as f32 * scale) as u32)
                    .min(self.width)
                    .max(x0 + 1);
                let mut acc = [0.0f32; 3];
                let mut n = 0.0f32;
                for sy in y0..y1 {
                    for sx in x0..x1 {
                        let s = self.px[(sy * self.width + sx) as usize];
                        acc[0] += s[0];
                        acc[1] += s[1];
                        acc[2] += s[2];
                        n += 1.0;
                    }
                }
                px.push([acc[0] / n, acc[1] / n, acc[2] / n]);
            }
        }
        LinearImage::new(target, th, px)
    }

    /// A rectangle of the image, clamped to its bounds.
    pub fn crop(&self, x: u32, y: u32, w: u32, h: u32) -> LinearImage {
        let x = x.min(self.width.saturating_sub(1));
        let y = y.min(self.height.saturating_sub(1));
        let w = w.min(self.width - x);
        let h = h.min(self.height - y);
        let mut px = Vec::with_capacity((w * h) as usize);
        for row in y..y + h {
            let start = (row * self.width + x) as usize;
            px.extend_from_slice(&self.px[start..start + w as usize]);
        }
        LinearImage::new(w, h, px)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_round_trips_every_byte() {
        // If the pair is not an exact inverse over the whole domain then every
        // "the two orders differ" observation is contaminated by conversion
        // drift, so this is checked exhaustively rather than at samples.
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
        // The table is only worth reporting if it is a speed result and not a
        // quality one, so the error is bounded over the whole domain rather
        // than sampled. One byte is the quantisation step itself.
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
    fn the_encode_table_pins_the_endpoints() {
        let t = SrgbEncodeTable::new();
        assert_eq!(t.encode(0.0), 0);
        assert_eq!(t.encode(1.0), 255);
        assert_eq!(t.encode(-1.0), 0);
        assert_eq!(t.encode(2.0), 255);
    }

    #[test]
    fn cropping_takes_the_rectangle_asked_for() {
        let img = LinearImage::new(
            4,
            2,
            (0..8).map(|i| [i as f32, 0.0, 0.0]).collect::<Vec<_>>(),
        );
        let c = img.crop(1, 0, 2, 2);
        assert_eq!(c.width, 2);
        assert_eq!(c.height, 2);
        assert_eq!(c.px[0][0], 1.0);
        assert_eq!(c.px[2][0], 5.0);
    }
}
