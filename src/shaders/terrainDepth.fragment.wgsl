// Writes NDC depth into the cascade atlas as R32F.
//
// Stored as a plain colour rather than sampled from a depth texture so PCSS can
// do its blocker search with ordinary filtered fetches — a comparison sampler
// would only ever hand back a pre-thresholded result, which is the one thing the
// blocker search cannot use.

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(input.position.z, 0.0, 0.0, 1.0);
}
