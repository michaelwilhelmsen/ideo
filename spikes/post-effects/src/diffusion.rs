//! Error diffusion, serially and in parallel — with the parallel version
//! producing byte-identical output.
//!
//! #52 says the interesting result is the asymmetry between ordered dither
//! (embarrassingly parallel) and error diffusion (inherently sequential),
//! because that asymmetry is what decides whether one honest preview UI covers
//! all seven families or two. Measuring that fairly means the parallel error
//! diffusion has to be a *real* parallelisation of the same algorithm, not a
//! different algorithm that happens to be faster:
//!
//! - Splitting the image into independent horizontal bands would parallelise
//!   perfectly and produce visible seams — a different picture, so a
//!   meaningless comparison.
//! - The block-interlaced/pinwheel schemes in the literature also change the
//!   output.
//!
//! What is used instead is the **pipelined-rows** scheme: row `y` may start as
//! soon as row `y-1` is [`Kernel::row_lead`] columns ahead, because that is the
//! furthest right any of the stencil's downward taps reaches. The speedup is
//! therefore bounded by the pipeline's fill cost rather than by the core count,
//! and that bound is the number this spike exists to report.
//!
//! ## Why the accumulator is split in two
//!
//! Row-lead alone makes the scheme *logically* exact but not *bit*-exact, and
//! the first version of this file was wrong for exactly that reason. With one
//! shared accumulator, row `y` writing its own forward taps into cell `(x, y)`
//! can land before row `y-1`'s later taps into the same cell — an ordering
//! raster order never produces. Floating-point addition is not associative, so
//! a handful of pixels then round to the other side of a quantisation boundary
//! and the two pictures differ.
//!
//! The fix is to give each cell two accumulators that are summed in a fixed
//! order at read time:
//!
//! - `carry` — everything arriving from the rows *above*. Rows `y-2` and `y-1`
//!   both write here, but the row lead already forces `y-2` to finish a column
//!   before `y-1` reaches it, so their writes are ordered anyway.
//! - `own` — the current row's own forward taps. Written and read by one
//!   thread, so it is a plain per-row scratch buffer and costs nothing shared.
//!
//! Serial and pipelined use the identical decomposition, which is what makes
//! [`tests::pipelined_matches_serial_exactly`] an equality and not a tolerance.

use std::sync::atomic::{AtomicU32, Ordering};

use crate::dither::Kernel;

/// A working buffer of `f32`s that several threads may accumulate into.
///
/// `AtomicU32` holding `f32` bits, loaded and stored `Relaxed`. The
/// accumulation (`store(load + delta)`) is *not* atomic and does not need to
/// be: the row-lead guarantee means no two threads ever touch the same cell
/// concurrently. What the atomics buy is the absence of a data race in the
/// language's terms — plain `&mut` aliasing across threads would be undefined
/// behaviour even where the accesses happen not to overlap in time. Visibility
/// comes from the `Acquire`/`Release` pair on the progress counters, not from
/// these.
struct SharedF32(Vec<AtomicU32>);

impl SharedF32 {
    fn zeroed(len: usize) -> Self {
        Self((0..len).map(|_| AtomicU32::new(0)).collect())
    }
    #[inline]
    fn get(&self, i: usize) -> f32 {
        f32::from_bits(self.0[i].load(Ordering::Relaxed))
    }
    #[inline]
    fn set(&self, i: usize, v: f32) {
        self.0[i].store(v.to_bits(), Ordering::Relaxed);
    }
    #[inline]
    fn add(&self, i: usize, delta: f32) {
        self.set(i, self.get(i) + delta);
    }
}

/// Run `kernel`'s error diffusion over `src` in raster order.
///
/// `quantise` maps an error-corrected value to the value actually emitted; the
/// difference between the two is what gets diffused. Everything about *what is
/// being quantised* — three colour channels against a palette, or one
/// luminance channel against a set of levels — is the caller's business, which
/// is exactly the seam the A/B needs.
pub fn diffuse_serial<const C: usize, F>(
    src: &[[f32; C]],
    width: u32,
    height: u32,
    kernel: Kernel,
    quantise: F,
) -> Vec<[f32; C]>
where
    F: Fn([f32; C]) -> [f32; C],
{
    assert!(
        kernel.is_sequential(),
        "{} is not a diffusion kernel",
        kernel.name()
    );
    let (w, h) = (width as usize, height as usize);
    let stencil = kernel.stencil();
    let mut carry = vec![[0.0f32; C]; src.len()];
    let mut own = vec![[0.0f32; C]; w];
    let mut out = vec![[0.0f32; C]; src.len()];

    for y in 0..h {
        own.iter_mut().for_each(|p| *p = [0.0; C]);
        for x in 0..w {
            let i = y * w + x;
            let value: [f32; C] = std::array::from_fn(|c| src[i][c] + carry[i][c] + own[x][c]);
            let emitted = quantise(value);
            out[i] = emitted;
            for c in 0..C {
                let err = value[c] - emitted[c];
                if err == 0.0 {
                    continue;
                }
                for (dx, dy, weight) in stencil {
                    let nx = x as i64 + *dx as i64;
                    let ny = y as i64 + *dy as i64;
                    if nx < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let d = err * weight;
                    if *dy == 0 {
                        own[nx as usize][c] += d;
                    } else {
                        carry[ny as usize * w + nx as usize][c] += d;
                    }
                }
            }
        }
    }
    out
}

/// The same diffusion, pipelined across rows. Output is identical to
/// [`diffuse_serial`], bit for bit.
pub fn diffuse_pipelined<const C: usize, F>(
    src: &[[f32; C]],
    width: u32,
    height: u32,
    kernel: Kernel,
    quantise: F,
) -> Vec<[f32; C]>
where
    F: Fn([f32; C]) -> [f32; C] + Sync,
{
    assert!(
        kernel.is_sequential(),
        "{} is not a diffusion kernel",
        kernel.name()
    );
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(height as usize)
        .max(1);
    if threads == 1 {
        return diffuse_serial(src, width, height, kernel, quantise);
    }

    let (w, h) = (width as usize, height as usize);
    let lead = kernel.row_lead();
    let stencil = kernel.stencil();

    let carry = SharedF32::zeroed(src.len() * C);
    let out = SharedF32::zeroed(src.len() * C);
    // Columns of each row that are finished. Rows are only ever advanced by
    // their owning thread, so this is a single-writer counter per row.
    let progress: Vec<AtomicU32> = (0..h).map(|_| AtomicU32::new(0)).collect();

    std::thread::scope(|scope| {
        for t in 0..threads {
            let (carry, out, progress, quantise) = (&carry, &out, &progress, &quantise);
            scope.spawn(move || {
                // Thread-local, because a row's own forward taps are read by
                // nobody else — and keeping them out of the shared plane is
                // what makes the summation order match raster order.
                let mut own = vec![[0.0f32; C]; w];
                let mut y = t;
                while y < h {
                    own.iter_mut().for_each(|p| *p = [0.0; C]);
                    for x in 0..w {
                        if y > 0 {
                            // Every downward tap from row `y-1` that can land
                            // on column `x` has been written once that row has
                            // finished column `x + lead - 1`. Capped at the
                            // width, or the last `lead` columns of a row would
                            // wait on a column the row above never reaches —
                            // and a row narrower than the lead would deadlock
                            // outright.
                            let need = ((x as u32) + lead).min(w as u32);
                            while progress[y - 1].load(Ordering::Acquire) < need {
                                std::hint::spin_loop();
                            }
                        }
                        let i = y * w + x;
                        let base = i * C;
                        let value: [f32; C] =
                            std::array::from_fn(|c| src[i][c] + carry.get(base + c) + own[x][c]);
                        let emitted = quantise(value);
                        for c in 0..C {
                            out.set(base + c, emitted[c]);
                            let err = value[c] - emitted[c];
                            if err == 0.0 {
                                continue;
                            }
                            for (dx, dy, weight) in stencil {
                                let nx = x as i64 + *dx as i64;
                                let ny = y as i64 + *dy as i64;
                                if nx < 0 || nx >= w as i64 || ny >= h as i64 {
                                    continue;
                                }
                                let d = err * weight;
                                if *dy == 0 {
                                    own[nx as usize][c] += d;
                                } else {
                                    carry.add((ny as usize * w + nx as usize) * C + c, d);
                                }
                            }
                        }
                        progress[y].store(x as u32 + 1, Ordering::Release);
                    }
                    y += threads;
                }
            });
        }
    });

    (0..src.len())
        .map(|i| std::array::from_fn(|c| out.get(i * C + c)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic, non-flat test image — flat input would let a broken
    /// pipeline pass by accident, since a constant image diffuses no error.
    fn noisy<const C: usize>(w: u32, h: u32) -> Vec<[f32; C]> {
        let mut state = 0x2545_F491u32;
        (0..(w * h) as usize)
            .map(|_| {
                std::array::from_fn(|_| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    (state % 1000) as f32 / 1000.0
                })
            })
            .collect()
    }

    fn to_two_levels<const C: usize>(v: [f32; C]) -> [f32; C] {
        std::array::from_fn(|c| if v[c] > 0.5 { 1.0 } else { 0.0 })
    }

    #[test]
    fn pipelined_matches_serial_exactly() {
        // The claim the benchmark rests on. If this ever fails, the parallel
        // number is measuring a different picture and must not be reported.
        for kernel in [Kernel::FloydSteinberg, Kernel::Atkinson] {
            let (w, h) = (97, 53);

            let src3 = noisy::<3>(w, h);
            let a = diffuse_serial(&src3, w, h, kernel, to_two_levels);
            let b = diffuse_pipelined(&src3, w, h, kernel, to_two_levels);
            assert_eq!(a, b, "{} disagreed on 3 channels", kernel.name());

            let src1 = noisy::<1>(w, h);
            let a = diffuse_serial(&src1, w, h, kernel, to_two_levels);
            let b = diffuse_pipelined(&src1, w, h, kernel, to_two_levels);
            assert_eq!(a, b, "{} disagreed on 1 channel", kernel.name());
        }
    }

    #[test]
    fn a_flat_half_grey_field_dithers_to_about_half_coverage() {
        // Error diffusion's defining property: the mean survives quantisation.
        // Atkinson drops a quarter of the error, so it is checked more loosely.
        for (kernel, tolerance) in [(Kernel::FloydSteinberg, 0.02), (Kernel::Atkinson, 0.10)] {
            let (w, h) = (128, 128);
            let src = vec![[0.5f32; 1]; (w * h) as usize];
            let out = diffuse_serial(&src, w, h, kernel, to_two_levels::<1>);
            let lit = out.iter().filter(|p| p[0] > 0.5).count() as f32 / out.len() as f32;
            assert!(
                (lit - 0.5).abs() < tolerance,
                "{} lit {lit} of the field",
                kernel.name()
            );
        }
    }

    #[test]
    fn a_single_row_still_works() {
        // The pipeline degenerates to one row; it must not deadlock waiting on
        // a predecessor that does not exist.
        let src = noisy::<1>(64, 1);
        let a = diffuse_serial(&src, 64, 1, Kernel::FloydSteinberg, to_two_levels::<1>);
        let b = diffuse_pipelined(&src, 64, 1, Kernel::FloydSteinberg, to_two_levels::<1>);
        assert_eq!(a, b);
    }

    #[test]
    fn a_narrow_image_still_works() {
        // Width below the row lead is the case where the pipeline has no slack
        // at all, so every row waits for its predecessor to finish outright.
        let src = noisy::<3>(1, 40);
        let a = diffuse_serial(&src, 1, 40, Kernel::Atkinson, to_two_levels::<3>);
        let b = diffuse_pipelined(&src, 1, 40, Kernel::Atkinson, to_two_levels::<3>);
        assert_eq!(a, b);
    }

    #[test]
    fn error_leaves_the_frame_at_the_edges_rather_than_wrapping() {
        // A wrapped tap would smear the right edge's error onto the left, which
        // shows up as a bright or dark seam down one side of every export.
        let (w, h) = (16u32, 16u32);
        let mut src = vec![[0.0f32; 1]; (w * h) as usize];
        src[(w - 1) as usize] = [0.9];
        let out = diffuse_serial(&src, w, h, Kernel::FloydSteinberg, to_two_levels::<1>);
        assert_eq!(
            out[w as usize][0], 0.0,
            "error wrapped to the next row's start"
        );
    }
}
